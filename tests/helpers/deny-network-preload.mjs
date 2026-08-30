import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const blocked = () => { throw new Error("Unexpected network protocol access during offline CLI test"); };

for (const [object, names] of [
  [http, ["get", "request"]],
  [https, ["get", "request"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
  [dgram, ["createSocket"]],
  [dns, ["lookup", "resolve", "resolve4", "resolve6"]],
]) {
  for (const name of names) object[name] = blocked;
}
syncBuiltinESMExports();
