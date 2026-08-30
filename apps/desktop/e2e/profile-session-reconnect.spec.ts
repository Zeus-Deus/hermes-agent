/**
 * Full-chain regression for #97764.
 *
 * A named local profile is served by its own routed WebSocket. Dropping that
 * socket after prompt.submit has acknowledged, but while inference is still
 * running, must reconnect and resume the durable session before the backend's
 * orphan reaper interrupts the turn. The prompt must not be replayed.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type MockBackendFixture,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { MOCK_REPLY, startMockServer } from './mock-server'
import { RealSessionBuilder } from './real-session-builder'
import { expect, test } from './test'

const PROFILE = 'youtube'
const SEED_PROMPT = 'E2E durable YouTube session before reconnect'
const LIVE_PROMPT = 'E2E hold this YouTube turn across a dropped profile socket'
const ORPHAN_REAP_GRACE_MS = 3_000

interface TrackedSocketWindow extends Window {
  __e2eGatewaySockets?: WebSocket[]
}

async function installWebSocketTracker(fixture: MockBackendFixture): Promise<void> {
  await fixture.page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket

    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) {
          super(url)
        } else {
          super(url, protocols)
        }

        const trackedWindow = window as TrackedSocketWindow
        trackedWindow.__e2eGatewaySockets ??= []
        trackedWindow.__e2eGatewaySockets.push(this)
      }
    }

    window.WebSocket = TrackedWebSocket
    ;(window as TrackedSocketWindow).__e2eGatewaySockets = []
  })

  // addInitScript applies on the next document. A cold renderer also mirrors
  // the reporter's reconnect path more closely than instrumenting app code.
  await fixture.page.reload()
  await waitForAppReady(fixture, 120_000)
}

async function trackedSocketCount(fixture: MockBackendFixture): Promise<number> {
  return fixture.page.evaluate(() => (window as TrackedSocketWindow).__e2eGatewaySockets?.length ?? 0)
}

async function waitForNewOpenSocket(fixture: MockBackendFixture, afterIndex: number): Promise<number> {
  await fixture.page.waitForFunction(
    index =>
      ((window as TrackedSocketWindow).__e2eGatewaySockets ?? []).some(
        (socket, socketIndex) => socketIndex > index && socket.readyState === WebSocket.OPEN
      ),
    afterIndex,
    { timeout: 60_000 }
  )

  return fixture.page.evaluate(index => {
    const sockets = (window as TrackedSocketWindow).__e2eGatewaySockets ?? []

    return sockets.findIndex((socket, socketIndex) => socketIndex > index && socket.readyState === WebSocket.OPEN)
  }, afterIndex)
}

async function textNodeOccurrences(fixture: MockBackendFixture, expected: string): Promise<number> {
  return fixture.page.evaluate(text => {
    const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')

    if (!viewport) return 0

    const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT)
    let count = 0

    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes(text)) count += 1
    }

    return count
  }, expected)
}

test('a named-profile turn resumes after its WebSocket drops mid-stream', async () => {
  test.setTimeout(180_000)

  const mock = await startMockServer({ holdFirstStreamForPrompt: LIVE_PROMPT })
  const sandbox = createSandbox('profile-session-reconnect')
  let fixture: MockBackendFixture | null = null

  try {
    writeMockProviderConfig(sandbox.hermesHome, mock.url)
    writeEnvFile(sandbox.hermesHome)

    const profileHome = path.join(sandbox.hermesHome, 'profiles', PROFILE)
    fs.mkdirSync(profileHome, { recursive: true })
    writeMockProviderConfig(
      profileHome,
      mock.url,
      undefined,
      `dashboard:\n  ws_orphan_reap_grace_s: ${ORPHAN_REAP_GRACE_MS / 1_000}`
    )
    writeEnvFile(profileHome)

    const builder = await RealSessionBuilder.start(profileHome)

    try {
      await builder.createSession({ title: SEED_PROMPT, turns: [SEED_PROMPT] })
    } finally {
      await builder.close()
    }

    const { app, page } = await launchDesktop(buildAppEnv(sandbox))
    fixture = {
      app,
      page,
      mock,
      mockUrl: mock.url,
      sandbox,
      cleanup: async () => undefined
    }

    await waitForAppReady(fixture, 120_000)
    await installWebSocketTracker(fixture)

    const beforeProfileSocket = (await trackedSocketCount(fixture)) - 1
    const profileButton = page
      .getByRole('group', { name: 'Profiles' })
      .getByRole('button', { name: PROFILE, exact: true })
    await expect(profileButton).toBeVisible({ timeout: 60_000 })
    await profileButton.click()
    await expect(profileButton).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 })

    const sessionRow = page.locator('[data-slot="sidebar"] button').filter({ hasText: SEED_PROMPT }).first()
    await expect(sessionRow).toBeVisible({ timeout: 60_000 })
    await sessionRow.click()
    await expect(page.getByText(SEED_PROMPT, { exact: true }).filter({ visible: true }).first()).toBeVisible({
      timeout: 60_000
    })

    const initialReplyCount = await textNodeOccurrences(fixture, MOCK_REPLY)

    const composer = page
      .locator('[data-slot="composer-root"] [contenteditable="true"]')
      .filter({ visible: true })
      .first()
    await composer.click()
    await composer.fill(LIVE_PROMPT)
    await page.keyboard.press('Enter')
    await mock.waitForHeldStream()

    // prompt.submit already returned here. The routed turn lease must keep the
    // profile socket alive until a terminal turn event, not just until the ACK.
    const profileSocketIndex = await waitForNewOpenSocket(fixture, beforeProfileSocket)
    expect(await textNodeOccurrences(fixture, LIVE_PROMPT), 'prompt duplicated before the forced drop').toBe(1)
    expect(
      await page.evaluate(
        index => ((window as TrackedSocketWindow).__e2eGatewaySockets ?? [])[index]?.readyState,
        profileSocketIndex
      )
    ).toBe(1)

    await page.evaluate(index => {
      const socket = ((window as TrackedSocketWindow).__e2eGatewaySockets ?? [])[index]
      socket?.close(4000, 'E2E mid-turn transport drop')
    }, profileSocketIndex)

    await waitForNewOpenSocket(fixture, profileSocketIndex)

    // Stay disconnected long enough that a stale runtime would be interrupted
    // by ws_orphan_reap. A reconnect that resumes the durable id cancels it.
    await page.waitForTimeout(ORPHAN_REAP_GRACE_MS + 1_500)
    expect(await textNodeOccurrences(fixture, LIVE_PROMPT), 'prompt duplicated during reconnect resume').toBe(1)
    mock.releaseHeldStream()

    await expect.poll(() => textNodeOccurrences(fixture!, MOCK_REPLY), { timeout: 60_000 }).toBe(initialReplyCount + 1)
    expect(await textNodeOccurrences(fixture, LIVE_PROMPT)).toBe(1)
    expect(mock.receivedPrompts.filter(prompt => prompt.includes(LIVE_PROMPT))).toHaveLength(1)
  } finally {
    await fixture?.app.close().catch(() => undefined)
    await mock.close()
    sandbox.cleanup()
  }
})
