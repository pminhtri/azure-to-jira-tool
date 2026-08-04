import assert from "node:assert/strict";
import { GatewayError, HttpError, NetworkError, requestJson } from "./http.ts";

/** Serve a fixed response, optionally after a redirect. */
function serve(handler: (req: Request) => Response) {
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  return { server, base: `http://localhost:${(server.addr as Deno.NetAddr).port}` };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("JSON responses parse normally", async () => {
  const s = serve(() => json({ ok: true }));
  try {
    assert.deepEqual(await requestJson(`${s.base}/x`, { retries: 0 }), { ok: true });
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("204 and empty bodies yield undefined", async () => {
  const s = serve(() => new Response(null, { status: 204 }));
  try {
    assert.equal(await requestJson(`${s.base}/x`, { retries: 0 }), undefined);
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("an SSO gateway answering with HTML is named, not reported as bad JSON", async () => {
  // A corporate F5 BIG-IP intercepts the API call and redirects to its login
  // page. The raw symptom is "not JSON", which sends people debugging Jira
  // instead of their VPN.
  const s = serve((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/rest/api/2/myself") {
      return new Response(null, { status: 302, headers: { location: "/my.policy" } });
    }
    return new Response(
      "<html><head><title>BIG-IP logout page</title></head><body>Please log in</body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
  });
  try {
    await assert.rejects(
      () => requestJson(`${s.base}/rest/api/2/myself`, { retries: 0 }),
      (err: Error) => {
        assert.equal(err instanceof GatewayError, true, `expected GatewayError, got ${err.name}`);
        assert.equal(err.message.includes("F5 BIG-IP"), true, err.message);
        assert.equal(err.message.includes("/my.policy"), true, err.message);
        assert.equal(err.message.includes("VPN"), true, err.message);
        assert.equal(
          err.message.includes("never seen by the server"),
          true,
          "must make clear the credentials are not at fault",
        );
        return true;
      },
    );
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("a generic login portal is still recognised as a gateway", async () => {
  const s = serve(() =>
    new Response("<!DOCTYPE html><html><body>Single Sign-On required</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  );
  try {
    await assert.rejects(
      () => requestJson(`${s.base}/rest/api/2/myself`, { retries: 0 }),
      (err: Error) => {
        assert.equal(err instanceof GatewayError, true);
        assert.equal(err.message.includes("SSO portal"), true, err.message);
        return true;
      },
    );
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("non-HTML garbage is still a plain HttpError", async () => {
  const s = serve(() => new Response("not json at all", { status: 200 }));
  try {
    await assert.rejects(
      () => requestJson(`${s.base}/x`, { retries: 0 }),
      (err: Error) => {
        assert.equal(err instanceof HttpError, true);
        assert.equal(err instanceof GatewayError, false);
        assert.equal(err.message.includes("not JSON"), true, err.message);
        return true;
      },
    );
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("HTTP errors carry a readable detail from the Jira error payload", async () => {
  const s = serve(() => json({ errorMessages: ["Boom"], errors: { summary: "is required" } }, 400));
  try {
    await assert.rejects(
      () => requestJson(`${s.base}/x`, { retries: 0 }),
      (err: HttpError) => {
        assert.equal(err.status, 400);
        assert.equal(err.detail, "Boom | summary: is required");
        return true;
      },
    );
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("statuses listed in tolerate are returned instead of thrown", async () => {
  const s = serve(() => json({ message: "nope" }, 404));
  try {
    const body = await requestJson<{ message: string }>(`${s.base}/x`, {
      retries: 0,
      tolerate: [404],
    });
    assert.equal(body.message, "nope");
  } finally {
    await s.server.shutdown();
  }
});

Deno.test("a network failure surfaces its underlying cause, not just 'fetch failed'", async () => {
  // Deno wraps every transport failure as "fetch failed"; the reason lives on
  // `cause`, and without it the log says nothing actionable.
  await assert.rejects(
    // Port 1 is reserved and refuses connections immediately.
    () => requestJson("http://127.0.0.1:1/rest/api/2/myself", { retries: 0 }),
    (err: Error) => {
      assert.equal(err instanceof NetworkError, true, `expected NetworkError, got ${err.name}`);
      assert.equal(err.message.includes("127.0.0.1:1"), true, err.message);
      assert.equal(
        err.message === "fetch failed",
        false,
        "the bare Deno message must not be the whole error",
      );
      return true;
    },
  );
});

Deno.test("an unresolvable host is not retried and names the DNS problem", async () => {
  const started = Date.now();
  await assert.rejects(
    // .invalid is reserved by RFC 2606 and never resolves.
    () => requestJson("https://no-such-host.invalid/rest/api/2/myself", { retries: 5 }),
    (err: Error) => {
      assert.equal(err instanceof NetworkError, true);
      assert.equal(err.message.includes("no-such-host.invalid"), true, err.message);
      return true;
    },
  );
  // With 5 retries the backoff alone would exceed 10s; a permanent failure
  // must short-circuit instead.
  assert.equal(Date.now() - started < 10_000, true, "DNS failures must not be retried");
});
