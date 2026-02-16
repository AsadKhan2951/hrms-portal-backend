export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  serviceApiUrl: process.env.SERVICE_API_URL ?? "",
  serviceApiKey: process.env.SERVICE_API_KEY ?? "",
};
