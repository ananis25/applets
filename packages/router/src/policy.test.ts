/** Every cell of the policy table in `can`. */
import { expect, test } from "vite-plus/test";

import {
  can,
  isCrossOrigin,
  isCrossOriginSessionWrite,
  visibilities,
  type Subject,
} from "./policy.ts";

const owner: Subject = { role: "user", email: "owner@example.com" };

const other: Subject = { role: "user", email: "other@example.com" };

const admin: Subject = { role: "admin", email: "admin@example.com" };

const stranger: Subject = null;

const applet = (visibility: (typeof visibilities)[number]) => ({
  owner: "owner@example.com",
  visibility,
});

test("the owner can use, edit and remove at every visibility", () => {
  for (const visibility of visibilities) {
    expect(can(owner, "use", applet(visibility))).toBe(true);
    expect(can(owner, "edit", applet(visibility))).toBe(true);
    expect(can(owner, "remove", applet(visibility))).toBe(true);
  }
});

test("another user and the admin use family and public applets, never private ones", () => {
  for (const subject of [other, admin]) {
    expect(can(subject, "use", applet("private"))).toBe(false);
    expect(can(subject, "use", applet("family"))).toBe(true);
    expect(can(subject, "use", applet("public"))).toBe(true);
  }
});

test("a stranger uses public applets only", () => {
  expect(can(stranger, "use", applet("private"))).toBe(false);
  expect(can(stranger, "use", applet("family"))).toBe(false);
  expect(can(stranger, "use", applet("public"))).toBe(true);
});

test("nobody but the owner edits, the admin included", () => {
  for (const visibility of visibilities) {
    for (const subject of [other, admin, stranger])
      expect(can(subject, "edit", applet(visibility))).toBe(false);
  }
});

test("the admin removes any applet, another user and a stranger none", () => {
  for (const visibility of visibilities) {
    expect(can(admin, "remove", applet(visibility))).toBe(true);
    expect(can(other, "remove", applet(visibility))).toBe(false);
    expect(can(stranger, "remove", applet(visibility))).toBe(false);
  }
});

test("an admin who owns the applet edits it", () => {
  expect(can(admin, "edit", { owner: "admin@example.com", visibility: "private" })).toBe(true);
});

test("a request from an applet's page is cross-origin, one from the editor's own page or a script is not", () => {
  const call = (origin?: string) =>
    new Request("https://app.example.com/api/applets/hello/run", {
      method: "POST",
      headers: origin === undefined ? {} : { origin },
    });

  expect(isCrossOrigin(call("https://evil.example.com"))).toBe(true);
  expect(isCrossOrigin(call("https://app.example.com"))).toBe(false);
  expect(isCrossOrigin(call())).toBe(false);
  expect(
    isCrossOrigin(
      new Request("https://app.example.com/api/applets/hello/run", {
        headers: { "sec-fetch-site": "same-site" },
      }),
    ),
  ).toBe(true);
});

test("a sibling page cannot write to a private applet with its visitor's session", () => {
  const call = (method: string, headers: Record<string, string>) =>
    new Request("https://notes.example.com/items", { method, headers });

  const session = { cookie: "applets.session=abc", origin: "https://games.example.com" };

  expect(isCrossOriginSessionWrite(call("POST", session))).toBe(true);
  expect(isCrossOriginSessionWrite(call("DELETE", session))).toBe(true);
  expect(
    isCrossOriginSessionWrite(
      call("POST", { cookie: session.cookie, "sec-fetch-site": "same-site" }),
    ),
  ).toBe(true);
  expect(isCrossOriginSessionWrite(call("GET", session))).toBe(false);
  expect(
    isCrossOriginSessionWrite(call("POST", { ...session, origin: "https://notes.example.com" })),
  ).toBe(false);
  expect(isCrossOriginSessionWrite(call("POST", { ...session, authorization: "Bearer key" }))).toBe(
    false,
  );
  expect(isCrossOriginSessionWrite(call("POST", { origin: session.origin }))).toBe(false);
});
