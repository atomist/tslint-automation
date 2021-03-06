/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { logger } from "@atomist/automation-client";
import { LoggingConfig } from "@atomist/automation-client/internal/util/logger";
import { GitHubRepoRef } from "@atomist/automation-client/operations/common/GitHubRepoRef";
import { GitCommandGitProject } from "@atomist/automation-client/project/git/GitCommandGitProject";
import * as stringify from "json-stringify-safe";
import "mocha";
import * as assert from "power-assert";
import { runTslint } from "../src/handlers/PushToTsLinting";

LoggingConfig.format = "cli";
(logger as any).level = process.env.LOG_LEVEL || "info";

const GitHubCredentials = { token: process.env.GITHUB_TOKEN };

describe("can we lint the thing?", () => {

    it("can lint a thing", done => {
        GitCommandGitProject.cloned(GitHubCredentials, new GitHubRepoRef("atomist", "upgrade-client-automation"))
            .then(project => runTslint(project))
            .then(result => {
                assert(!result.success, stringify(result));
            })
            .then(() => done(), done);
    }).timeout(240000);
});
