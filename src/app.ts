import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

/** Composes Flue's discovered resources without publishing a Patchdesk review route. */
const app = new Hono();

app.route("/", flue());

export default app;
