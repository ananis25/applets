#!/usr/bin/env node
/** The repo's scripts, behind `vp run push`, `vp run remove`, `vp run deploy`, `vp run destroy` and `vp run dev`. */
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { platformDeploy, platformDestroy, platformDev, targets } from "./platform.ts";
import { push, remove, visibilities } from "./push.ts";

const pushCommand = Command.make(
  "push",
  {
    path: Argument.String("path").pipe(Argument.withDescription("the applet directory")),
    visibility: Flag.Literals("visibility", visibilities).pipe(
      Flag.withDescription(
        "who may reach it: private is only you, family is everyone who can sign in, public is anyone. A new applet is private, and without the flag a push leaves the setting alone",
      ),
      Flag.optional,
    ),
  },
  ({ path, visibility }) => push(path, Option.getOrUndefined(visibility)),
).pipe(Command.withDescription("Upload an applet directory; the platform bundles and serves it"));

const removeCommand = Command.make(
  "remove",
  { name: Argument.String("name").pipe(Argument.withDescription("the applet to delete")) },
  ({ name }) => remove(name),
).pipe(
  Command.withDescription(
    "Delete an applet with its versions, storage and blobs; a push recreates it",
  ),
);

const deployCommand = Command.make(
  "deploy",
  {
    targets: Argument.Literals("target", targets).pipe(
      Argument.withDescription("the workers to deploy; all three when none is named"),
      Argument.variadic(),
    ),
  },
  ({ targets: chosen }) => platformDeploy(chosen),
).pipe(Command.withDescription("wrangler deploy the bundler, the editor and the router"));

const destroyCommand = Command.make(
  "destroy",
  {
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("delete; without it the command only lists what it would delete"),
      Flag.withDefault(false),
    ),
  },
  ({ yes }) => platformDestroy(yes),
).pipe(
  Command.withDescription("Delete the workers, the registry and the buckets from the account"),
);

const devCommand = Command.make("dev", {}, () => platformDev).pipe(
  Command.withDescription(
    "The local platform on port 8787, and the editor page on Vite against it",
  ),
);

const applets = Command.make("applets").pipe(
  Command.withDescription("Applets, a personal platform on Cloudflare Workers"),
  Command.withSubcommands([pushCommand, removeCommand, deployCommand, destroyCommand, devCommand]),
);

const report = (error: { readonly message: string }) =>
  Effect.sync(() => {
    console.error(error.message);
    process.exitCode = 1;
  });

Command.run(applets, { version: "0.0.0" }).pipe(
  Effect.catchTag("CliError", report),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
  NodeRuntime.runMain({ disableErrorReporting: false }),
);
