// Fork schemas stay grouped outside the main public barrel so the upstream
// export list keeps its size and fork additions stay reviewable in one place.
export {
  SessionsCatalogReorderParamsSchema,
  SessionsCatalogReorderResultSchema,
  SessionsCatalogMoveParamsSchema,
  SessionsCatalogMoveResultSchema,
} from "./schema-modules.js";

// Fork: restart-pending notice (gateway.restart, snapshot.gatewayRestart).
export * from "./schema/gateway-restart.js";
export * from "./schema/gateway-maintenance.js";
