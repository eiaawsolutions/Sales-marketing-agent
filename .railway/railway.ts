import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const salesMarketingAgentVolume = volume("sales-marketing-agent-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 5000 });
  const SalesMarketingAgent = service("Sales-marketing-agent", {
    source: github("eiaawsolutions/Sales-marketing-agent", { checkSuites: true }),
    // Carried over from railway.toml (Config as Code stops being read 2026-12-01).
    // Railway does not read this file on deploy — `railway config apply` stores
    // these on the service, so they must match the Dockerfile + /api/health.
    build: { builder: "DOCKERFILE", dockerfilePath: "./Dockerfile" },
    start: "node src/server.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    // Restart policy type is left at Railway's default, On Failure (Railway
    // stores the default as null, so declaring it here would show as a
    // permanent plan diff). Only the retry cap differs from the default of 10.
    deploy: { restartPolicyMaxRetries: 5 },
    replicas: { "asia-southeast1-eqsg3a": 1 },
    domains: [{ domain: "sa.eiaawsolutions.com", port: 3000 }],
    networking: { privateNetworkEndpoint: "sales-marketing-agent" },
    volumeMounts: { "/app/data": salesMarketingAgentVolume },
    env: { ALLOWED_ORIGINS: preserve(), ANTHROPIC_API_KEY: preserve(), ENCRYPTION_KEY: preserve(), FROM_EMAIL: preserve(), PORT: preserve(), PUBLIC_BASE_URL: preserve(), RESEND_API_KEY: preserve(), SMTP_HOST: preserve(), SMTP_PASS: preserve(), SMTP_PORT: preserve(), SMTP_USER: preserve(), STRIPE_WEBHOOK_SECRET: preserve(), VOICE_REFRESH_TOKEN: preserve() },
  });

  return project("EIAAW Sales marketing agent", {
    resources: [SalesMarketingAgent, salesMarketingAgentVolume],
  });
});
