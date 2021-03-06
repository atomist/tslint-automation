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

import { HandleCommand, HandlerContext, Success } from "@atomist/automation-client";
import { Parameters } from "@atomist/automation-client/decorators";
import { commandHandlerFrom } from "@atomist/automation-client/onCommand";
import * as slack from "@atomist/slack-messages/SlackMessages";
import { adminSlackUserNames, packageJson } from "../../credentials";
import { PeopleWhoDoNotWantMeToOfferToHelp, PeopleWhoWantLintingOnTheirBranches } from "../PushToTsLinting";

@Parameters()
export class ReportConfigurationParams {

}

async function reportConfiguration(ctx: HandlerContext, params: ReportConfigurationParams): Promise<any> {

    const text = "tslint-automation loves to fix your linting errors! " +
        "Sometimes `tslint --fix` is enough, and then I'll offer to make a commit." +
        "Other times there are harder errors, and I'll list them for you in DM. " +
        "Some of them I can fix with your approval, and I'll give you buttons for those.";
    const myAttachment: slack.Attachment = {
        fallback: "describe tslint-automation",
        title: packageJson.name,
        title_link: packageJson.repository,
        text,
        fields: [{ title: "admin", value: adminSlackUserNames[0], short: true }],
    };
    // todo: list commands?
    const configurationAttachment: slack.Attachment = {
        fallback: "config",
        title: "Currently...",
        fields: [{ title: "Always lint commits from:", value: PeopleWhoWantLintingOnTheirBranches.join(", "), short: false },
            { title: "Never offer to help:", value: PeopleWhoDoNotWantMeToOfferToHelp.join(", "), short: false }],
    };
    const message: slack.SlackMessage = {
        attachments: [myAttachment, configurationAttachment],
    };
    await ctx.messageClient.respond(message);
    return Success;
}

export const reportConfigurationCommand: HandleCommand<ReportConfigurationParams> =
    commandHandlerFrom(reportConfiguration, ReportConfigurationParams, "ReportConfiguration",
        "Let me tell you about tslint-automation", "man tslint-automation");
