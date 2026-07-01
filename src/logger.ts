import pino from "pino";
import { appConfig } from "./config.js";

export const logger = pino({
  level: appConfig.logLevel,
  // The codebase logs errors under an `error` key (not pino's own `err`), so
  // bind the standard error serializer there too — otherwise a plain Error
  // object serializes to `{}` (message/stack are non-enumerable) and every
  // failure log loses its diagnostic value.
  serializers: { error: pino.stdSerializers.err }
});

