declare module "bun" {
  interface Env {
    ATLASSIAN_API_TOKEN: string
    ATLASSIAN_EMAIL: string
    ATLASSIAN_BASE_URL: string
  }
}
