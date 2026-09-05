import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard route controls use the existing validated IPC mutation", async () => {
  const source = (await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  assert.match(source, /useOptimisticValues/);
  assert.match(source, /api\.setProviderEnabled\(provider\.id, next\)/);
  assert.match(source, /onNavigate\("models"\)/);
  const panel = source.match(/function RouteDashboardPanel[\s\S]*?\n}\n\n/)?.[0] || "";
  assert.ok(panel, "route dashboard panel should be present");
  assert.doesNotMatch(panel, /credential|apiKey|accessToken|sessionId/);
});

test("dashboard places token activity before the expanded provider routes card", async () => {
  const source = (await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const tokenActivity = source.indexOf("<TokenActivity");
  const providerRoutes = source.indexOf("<RouteDashboardPanel");
  assert.ok(tokenActivity >= 0, "token activity should be rendered");
  assert.ok(providerRoutes > tokenActivity, "provider routes should follow token activity");
  const panel = source.match(/function RouteDashboardPanel[\s\S]*?\n}\n\n/)?.[0] || "";
  assert.doesNotMatch(panel, /accordion|detailsOpen|aria-expanded/);
});

test("dashboard contract is attached to the shared catalog snapshot", async () => {
  const source = (await readFile(new URL("../src/control.mjs", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  assert.match(source, /dashboard: routerDashboardState\(\{ models \}\)/);
  assert.match(source, /const \{ routerDashboardState \} = await import\("\.\/router-dashboard\.mjs"\)/);
});

test("tray consumes only the dashboard route summary", async () => {
  const source = (await readFile(new URL("../apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  assert.match(source, /struct RouterDashboardSnapshot: Decodable/);
  assert.match(source, /providerDashboardSummary/);
  const contract = source.match(/struct RouterDashboardSnapshot[\s\S]*?struct RouterDashboardModel[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(contract, /credential|endpoint|session|accountId/);
});
