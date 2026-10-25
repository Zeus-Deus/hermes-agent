"""Classic CLI model refusal copy stays local without widening RPC diagnostics."""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from agent import i18n
from hermes_cli import cli_model_switch_mixin as model_switch
from hermes_cli.gateway_client import GatewayClientError, GatewayRPCError, rpc_error


class ModelSwitchCodeSkewCopyTests(unittest.TestCase):
    def setUp(self):
        i18n.reset_language_cache()
        self.addCleanup(i18n.reset_language_cache)

    def render_switch(self, outcome):
        lines = []
        facade = SimpleNamespace(_cprint=lines.append, CLI_CONFIG={})
        agent = SimpleNamespace(switch_model=Mock())
        if isinstance(outcome, Exception):
            agent.switch_model.side_effect = outcome
        else:
            agent.switch_model.return_value = outcome
        cli = SimpleNamespace(agent=agent, model="standard-model", provider="old-provider",
                              requested_provider="old-provider", _explicit_api_key="old-key",
                              _explicit_base_url="old-url", api_key="old-key", base_url="old-url",
                              api_mode="old-mode", reasoning_config={"effort": "low"},
                              _confirmed_switch_warning="owned warning")
        before = model_switch._runtime_fields(cli)
        result = SimpleNamespace(new_model="extended-model", target_provider="new-provider",
                                 api_key="new-key", base_url="new-url", api_mode="new-mode")
        # Only the CLI facade's output/config boundary is replaced; execute the real stage,
        # reasoning resolution, exception rendering and rollback without launching an agent.
        with patch.dict("sys.modules", {"cli": facade}):
            accepted = model_switch.CLIModelSwitchMixin._stage_and_swap_model(
                cli, result, "standard-model")
        self.assertIsNone(cli._confirmed_switch_warning)
        if outcome is not True:
            self.assertFalse(accepted)
            self.assertEqual(model_switch._runtime_fields(cli), before)
        return accepted, lines

    def test_typed_code_skew_has_local_restart_guidance(self):
        remote = "REMOTE_DIAGNOSTIC_MUST_NOT_RENDER"
        error = rpc_error({"code": 5098, "message": remote + " /private/path",
                           "data": {"reason": "code_skew", "detail": remote,
                                    "boot_rev": remote}})
        self.assertIsInstance(error, GatewayRPCError)
        self.assertEqual(str(error), "code_skew")
        _, lines = self.render_switch(error)
        text = "\n".join(lines)
        self.assertIn("hermes gateway restart", text)
        self.assertIn("code_skew", text)
        self.assertIn("staying on standard-model", text)
        self.assertNotIn(remote, text)
        self.assertNotIn("/private/path", text)
        self.assertEqual(str(error), "code_skew")

    def test_other_refusals_cancellation_and_success_keep_existing_copy(self):
        for error in (GatewayRPCError("code_skew", code=5000),
                      GatewayRPCError("code_skew"), GatewayClientError("code_skew"),
                      GatewayRPCError("unknown_refusal", code=5098,
                                      data={"detail": "REMOTE_DETAIL"})):
            with self.subTest(error=repr(error), code=getattr(error, "code", None)):
                _, lines = self.render_switch(error)
                self.assertEqual(lines, ["  " + i18n.t(
                    "cli.model.switch_failed", model="extended-model", error=error,
                    old_model="standard-model")])
                self.assertNotIn("hermes gateway restart", "\n".join(lines))
                self.assertNotIn("REMOTE_DETAIL", "\n".join(lines))
        _, lines = self.render_switch(False)
        self.assertEqual(lines, ["  " + i18n.t("cli.model.switch_cancelled")])
        accepted, lines = self.render_switch(True)
        self.assertTrue(accepted)
        self.assertEqual(lines, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
