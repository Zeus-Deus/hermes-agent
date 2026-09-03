import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const ACTIVE_SURFACE = '[data-composer-target]:not([data-pane-hidden] [data-composer-target])'

let fixture: MockBackendFixture | null = null
let root = ''
let sessionRepo = ''

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'desktop-e2e@example.invalid'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'Desktop E2E'], { cwd: path })
  writeFileSync(join(path, 'README.md'), 'fixture\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: path })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: path })
}

test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hermes-worktree-slash-'))
  sessionRepo = join(root, 'session-repo')
  initRepo(sessionRepo)

  fixture = await setupMockBackend({
    extraConfig: `terminal:\n  cwd: ${JSON.stringify(sessionRepo)}`
  })
  await waitForAppReady(fixture)
})

test.afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
  rmSync(root, { force: true, recursive: true })
})

test('desktop /worktree new uses the session repo and moves that session', async () => {
  test.setTimeout(180_000)
  const page = fixture!.page
  const activeSurface = () => page.locator(ACTIVE_SURFACE).last()
  const composer = activeSurface().locator('[contenteditable="true"]').first()

  await composer.fill('create a repo-backed session')
  await page.keyboard.press('Enter')
  await expect(activeSurface().locator('[data-slot="aui_thread-viewport"]')).toContainText('mock inference server', {
    timeout: 60_000
  })

  await composer.fill('/worktree new desktop-e2e')
  await page.keyboard.press('Enter')

  const worktreePath = join(sessionRepo, '.worktrees', 'desktop-e2e')
  await expect.poll(() => existsSync(worktreePath), { timeout: 30_000 }).toBe(true)
  await expect(activeSurface()).toContainText(`Worktree ready: ${worktreePath}`, { timeout: 30_000 })
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: worktreePath, encoding: 'utf8' }).trim()).toBe(
    'hermes/desktop-e2e'
  )

  await composer.fill('/worktree status')
  await page.keyboard.press('Enter')
  await expect(activeSurface()).toContainText(`Active worktree: ${worktreePath}`, { timeout: 30_000 })
})
