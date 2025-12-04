// Check if debug mode is enabled via DEBUG env
export const DEBUG_MODE = Bun.env.DEBUG === "1" || Bun.env.DEBUG === "true";
