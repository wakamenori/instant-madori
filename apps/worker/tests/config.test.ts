import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/api/config.ts";

const remote = {
  ENVIRONMENT: "staging",
  APP_ORIGINS: "https://app.example.com",
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ACCESS_AUD: "app-audience",
};
const local = {
  ...remote,
  ENVIRONMENT: "local",
  ACCESS_TEAM_DOMAIN: "https://access.local.invalid",
  ACCESS_JWKS: JSON.stringify({ keys: [{ kty: "RSA" }] }),
};

await test("Verifier configuration", async (t) => {
  const clientId = "verifier-client.access";

  await t.test("staging accepts an explicitly configured verifier Client ID", () => {
    const config = loadConfig({ ...remote, ACCESS_VERIFIER_CLIENT_ID: clientId });
    assert.equal(config.access.verifierClientId, clientId);
    assert.deepEqual(config.access.keys, { kind: "remote" });
  });

  for (const env of [local, { ...remote, ENVIRONMENT: "production" }]) {
    await t.test(`${env.ENVIRONMENT} rejects the verifier setting`, () => {
      assert.throws(() => loadConfig({ ...env, ACCESS_VERIFIER_CLIENT_ID: clientId }), {
        name: "ConfigError",
        message: /ACCESS_VERIFIER_CLIENT_ID/,
      });
    });
  }

  for (const value of ["", "   ", 123]) {
    await t.test(`an invalid verifier setting (${JSON.stringify(value)}) is rejected`, () => {
      assert.throws(() => loadConfig({ ...remote, ACCESS_VERIFIER_CLIENT_ID: value }), {
        name: "ConfigError",
        message: /ACCESS_VERIFIER_CLIENT_ID/,
      });
    });
  }

  for (const env of [local, remote, { ...remote, ENVIRONMENT: "production" }]) {
    await t.test(`${env.ENVIRONMENT} works without a verifier setting`, () => {
      assert.equal(loadConfig(env).access.verifierClientId, undefined);
    });
  }

  for (const env of [
    { ...local, ENVIRONMENT: "staging" },
    { ...remote, ACCESS_TEAM_DOMAIN: local.ACCESS_TEAM_DOMAIN },
    { ...remote, ACCESS_JWKS: local.ACCESS_JWKS },
  ]) {
    await t.test("enabling the verifier does not permit local keys or .invalid issuers", () => {
      assert.throws(() => loadConfig({ ...env, ACCESS_VERIFIER_CLIENT_ID: clientId }), {
        name: "ConfigError",
      });
    });
  }
});

await test("Job test hold configuration fails closed", () => {
  for (const env of [local, remote, { ...remote, ENVIRONMENT: "production" }]) {
    loadConfig({ ...env, JOB_TEST_HOLD: "none" });
    for (const value of [
      "",
      "before_render:0",
      "before_commit:7201",
      "before_render:01",
      "after_render:10",
      "before_render:1.5",
      123,
    ]) {
      assert.throws(() => loadConfig({ ...env, JOB_TEST_HOLD: value }), {
        name: "ConfigError",
        message: /JOB_TEST_HOLD/,
      });
    }
  }
  for (const value of ["before_render:1", "before_commit:7200"]) {
    loadConfig({ ...local, JOB_TEST_HOLD: value });
    loadConfig({ ...remote, JOB_TEST_HOLD: value });
    assert.throws(
      () => loadConfig({ ...remote, ENVIRONMENT: "production", JOB_TEST_HOLD: value }),
      { name: "ConfigError", message: /JOB_TEST_HOLD/ },
    );
  }
});
