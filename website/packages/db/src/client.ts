import postgres, { type Sql } from "postgres";
import { ensureDatabaseSchema } from "./schema";

export interface DatabaseConfig {
  enabled: boolean;
  url: string;
}

let databaseClientPromise: Promise<Sql | null> | null = null;
let databaseInitWarningPrinted = false;

export function createDatabaseConfig(): DatabaseConfig {
  const url = process.env.DATABASE_URL?.trim() ?? "";

  return {
    enabled: url.length > 0,
    url,
  };
}

export function isDatabaseConfigured() {
  return createDatabaseConfig().enabled;
}

function printDatabaseInitWarning(error: unknown) {
  if (databaseInitWarningPrinted) {
    return;
  }

  databaseInitWarningPrinted = true;
  console.warn("[db] falling back to file persistence", error);
}

export async function getDatabaseClient() {
  if (databaseClientPromise) {
    return databaseClientPromise;
  }

  const config = createDatabaseConfig();

  if (!config.enabled) {
    databaseClientPromise = Promise.resolve(null);
    return databaseClientPromise;
  }

  databaseClientPromise = (async () => {
    try {
      const sql = postgres(config.url, {
        connect_timeout: 5,
        idle_timeout: 5,
        max: 1,
        prepare: false,
      });

      await ensureDatabaseSchema(sql);
      return sql;
    } catch (error) {
      printDatabaseInitWarning(error);
      return null;
    }
  })();

  return databaseClientPromise;
}

export async function withDatabase<T>(
  handler: (client: Sql) => Promise<T>,
) {
  const client = await getDatabaseClient();

  if (!client) {
    return undefined;
  }

  return handler(client);
}
