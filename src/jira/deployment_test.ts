import assert from "node:assert/strict";
import { JiraClient } from "./client.ts";
import { makeConfig } from "../testing/fixtures.ts";

function client(overrides: Partial<ReturnType<typeof makeConfig>["jira"]>) {
  const cfg = makeConfig();
  Object.assign(cfg.jira, overrides);
  return new JiraClient(cfg);
}

/** Capture the Authorization header of the first request. */
function startCapture(body: unknown, status = 200) {
  let seen: string | null = null;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    seen ??= req.headers.get("authorization");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { server, base: `http://localhost:${(server.addr as Deno.NetAddr).port}`, auth: () => seen };
}

Deno.test("the hostname drives the initial guess", () => {
  assert.equal(client({ baseUrl: "https://sioux.atlassian.net" }).flavor, "cloud");
  assert.equal(client({ baseUrl: "https://jira.example.com" }).flavor, "server");
  assert.equal(client({ baseUrl: "http://localhost:8080" }).flavor, "server");
});

Deno.test("JIRA_DEPLOYMENT overrides the hostname guess", () => {
  assert.equal(client({ baseUrl: "https://jira.example.com", deployment: "cloud" }).flavor, "cloud");
  assert.equal(client({ baseUrl: "https://x.atlassian.net", deployment: "server" }).flavor, "server");
});

Deno.test("token only sends Bearer; email present sends Basic", async () => {
  const bearer = startCapture({ deploymentType: "Server" });
  try {
    const c = client({ baseUrl: bearer.base, email: "", apiToken: "pat-xyz" });
    await c.detectDeployment();
    assert.equal(bearer.auth(), "Bearer pat-xyz");
  } finally {
    await bearer.server.shutdown();
  }

  const basic = startCapture({ deploymentType: "Cloud" });
  try {
    const c = client({ baseUrl: basic.base, email: "a@b.c", apiToken: "tok" });
    await c.detectDeployment();
    assert.equal(basic.auth(), `Basic ${btoa("a@b.c:tok")}`);
  } finally {
    await basic.server.shutdown();
  }
});

Deno.test("JIRA_AUTH forces the auth scheme", async () => {
  const s = startCapture({ deploymentType: "Server" });
  try {
    // Email is set but bearer is forced, so Bearer must still be sent.
    const c = client({ baseUrl: s.base, email: "a@b.c", apiToken: "pat", authScheme: "bearer" });
    await c.detectDeployment();
    assert.equal(s.auth(), "Bearer pat");
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("serverInfo refines the initial guess", async () => {
  // An unfamiliar domain that is really Cloud, e.g. behind a proxy/CNAME.
  const s = startCapture({ deploymentType: "Cloud", version: "1001.0.0" });
  try {
    const c = client({ baseUrl: s.base });
    assert.equal(c.flavor, "server", "before asking, the hostname implies server");
    const { deployment, info } = await c.detectDeployment();
    assert.equal(deployment, "cloud");
    assert.equal(info.version, "1001.0.0");
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("a bad token (401) KEEPS the hostname guess instead of falling back to cloud", async () => {
  // This was a real bug: 401 -> deploymentType unreadable -> defaulted to cloud
  // -> every request hit /rest/api/3, which self-hosted Jira does not have.
  const s = startCapture({ message: "Unauthorized" }, 401);
  try {
    const c = client({ baseUrl: s.base, email: "", apiToken: "sai" });
    const { deployment } = await c.detectDeployment();
    assert.equal(deployment, "server");
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("a 401 with a PAT reports the actual cause", async () => {
  const s = startCapture({ message: "Unauthorized" }, 401);
  try {
    const c = client({ baseUrl: s.base, email: "", apiToken: "sai" });
    await assert.rejects(
      () => c.myself(),
      (err: Error) => {
        assert.equal(err.message.includes("PAT"), true, err.message);
        assert.equal(err.message.includes("JIRA_EMAIL"), true, err.message);
        assert.equal(err.message.includes("8.14"), true, err.message);
        return true;
      },
    );
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("the assignee reference differs between flavours", () => {
  assert.deepEqual(client({ baseUrl: "https://x.atlassian.net" }).assigneeRef("acc-1"), { id: "acc-1" });
  assert.deepEqual(client({ baseUrl: "https://jira.example.com" }).assigneeRef("jdoe"), {
    name: "jdoe",
  });
});

Deno.test("renderDoc: Cloud keeps ADF, Server yields a wiki string", () => {
  const doc = {
    version: 1 as const,
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
  };
  assert.equal(typeof client({ baseUrl: "https://x.atlassian.net" }).renderDoc(doc), "object");
  assert.equal(client({ baseUrl: "https://jira.example.com" }).renderDoc(doc), "hello");
});
