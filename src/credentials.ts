
import * as cfenv from "cfenv";

import * as appRoot from "app-root-path";
import { logger } from "@atomist/automation-client";

const appEnv = cfenv.getAppEnv();
const githubCredsFromCloudFoundry = appEnv.getServiceCreds("github-token");
let token = process.env.GITHUB_TOKEN;
if (githubCredsFromCloudFoundry) {
    logger.info("Using github token from Cloud Foundry environment");
    token = githubCredsFromCloudFoundry.token;
}

export const adminCreds = { token };
export const adminSlackUserNames = ["jessica", "jessitron"];
export const adminChannelId = "C8JUBSYKD";
export const adminGitHubUser = "jessitron";

export let gitInfo = { sha: "unknown", branch: "unknown", repository: "unknown" };
try {
    gitInfo = require(appRoot.path + "/git-info.json");
    logger.info("Found git-info.json!");
} catch (e) {
    logger.warn("Did not locate git-info.json");
}