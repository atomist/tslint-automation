import { EventFired, EventHandler, HandleEvent, HandlerContext, HandlerResult, Success } from "@atomist/automation-client";
import { subscriptionFromFile } from "@atomist/automation-client/graph/graphQL";
import * as _ from "lodash";
import * as graphql from "../typings/types";

import { adminChannelId, adminSlackUserNames } from "../credentials";
import * as stopBotheringMe from "./Configuration/SelfConfigurate";

@EventHandler("Update some messages when a build status arrives",
    subscriptionFromFile("graphql/subscription/anyBuild"))
export class UpdateMessageOnBuild implements HandleEvent<graphql.BuildFromPush.Subscription> {

    public handle(event: EventFired<graphql.BuildFromPush.Subscription>,
                  context: HandlerContext): Promise<HandlerResult> {

        const build = event.data.Build[0];

        if (stopBotheringMe.isMine({ message: build.commit.message })) {
            const author = _.get(build, "commit.author.person.chatId.screenName",
                build.commit.author.login);

            return context.messageClient.addressChannels("recognized a build for stop-bothering-me", adminChannelId)
                .then(() => stopBotheringMe.reportProgress(context, author,
                    stopBotheringMe.parseMessageId(build.commit.message), {
                        sha: build.commit.sha,
                        buildUrl: build.buildUrl,
                        buildStatusEmoji: pickEmoji(build.status),
                    }));
        }

        return Promise.resolve(Success);
    }
}

// can I get our little pending gif as an emoji please?
function pickEmoji(status: graphql.BuildStatus): string {
    switch (status) {
        case "passed":
            return ":white_check_mark:";
        case "broken":
        case "failed":
            return ":red_circle:";
        case "started":
            return ":running:";
        case "canceled":
            return ":stop:";
    }
}
