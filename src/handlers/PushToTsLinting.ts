import { EventFired, HandleEvent, HandlerContext, HandlerResult, Secrets, success } from "@atomist/automation-client";
import { runCommand } from "@atomist/automation-client/action/cli/commandLine";
import { EventHandler, Secret } from "@atomist/automation-client/decorators";
import * as GraphQL from "@atomist/automation-client/graph/graphQL";
import { logger } from "@atomist/automation-client/internal/util/logger";
import { GitHubRepoRef } from "@atomist/automation-client/operations/common/GitHubRepoRef";
import { SourceLocation } from "@atomist/automation-client/operations/common/SourceLocation";
import { GitCommandGitProject } from "@atomist/automation-client/project/git/GitCommandGitProject";
import { GitProject } from "@atomist/automation-client/project/git/GitProject";
import { GitStatus } from "@atomist/automation-client/project/git/gitStatus";
import * as slack from "@atomist/slack-messages/SlackMessages";
import * as appRoot from "app-root-path";
import { exec } from "child-process-promise";
import * as stringify from "json-stringify-safe";
import * as _ from "lodash";
import { configuration } from "../atomist.config";
import * as graphql from "../typings/types";
import { getFileContent } from "../util/getFileContent";

const PeopleWhoWantLintingOnTheirBranches = ["cd", "jessica", "jessitron", "clay"];
const me = ["jessica", "jessitron"];
const CommitMessage = `Automatic de-linting\n[atomist:auto-delint]`;

interface Analysis {
    project: GitProject;
    author: string;
    lintable: boolean;
    happy?: boolean;
    changed: boolean;
    status?: GitStatus;
    personCares: boolean;
    pushed: boolean;
    error?: Error;
    problems?: Problem[];
}

function stringifyAnalysis(a: Analysis): string {
    return `personCares? ${a.personCares}
lintable? ${a.lintable}
happy?    ${a.happy}
changed?  ${a.changed}
pushed?   ${a.pushed}
status:   ${stringify(a.status)}
error: ${a.error}`;
}

function lintingIsWanted(push: graphql.PushToTsLinting.Push, author: string): boolean {

    if (!PeopleWhoWantLintingOnTheirBranches.includes(author)) {
        return false;
    }
    // TODO: actually don't even try in this case, this is different
    if (push.after.message === CommitMessage) {
        // haha, I made this commit
        return false;
    }
    return true;
}

@EventHandler("Runs ts tslint --fix on a given repository",
    GraphQL.subscriptionFromFile("graphql/subscription/pushToTsLinting"))
export class PushToTsLinting implements HandleEvent<graphql.PushToTsLinting.Subscription> {

    @Secret(Secrets.OrgToken)
    public githubToken: string;

    public handle(event: EventFired<graphql.PushToTsLinting.Subscription>,
                  ctx: HandlerContext, params: this): Promise<HandlerResult> {
        const push = event.data.Push[0];

        const author: string = _.get(push, "after.author.person.chatId.screenName") ||
            _.get(push, "after.author.login") || "unknown";

        const personCares: boolean = lintingIsWanted(push, author);

        initialReport(ctx, push, author);

        // end debugging

        const startAnalysis: Partial<Analysis> = { personCares, author };

        const projectPromise: Promise<GitProject> = GitCommandGitProject.cloned({ token: params.githubToken },
            new GitHubRepoRef(push.repo.owner, push.repo.name, push.branch));
        const isItLintable: Promise<Partial<Analysis>> = projectPromise.then(project => {
            if (project.fileExistsSync("tslint.json")) {
                return { ...startAnalysis, project, lintable: true };
            } else {
                return { ...startAnalysis, project, lintable: false };
            }
        });
        const soLintIt: Promise<Partial<Analysis>> = isItLintable.then(soFar => {
            if (soFar.lintable) {
                return runCommand(`bash ${appRoot}/scripts/run-lint.bash`, { cwd: soFar.project.baseDir })
                    .then(result => ({ ...soFar, happy: true }),
                        error => ({ ...soFar, happy: false, error, problems: findComplaints(push, error.stdout) }));
            } else {
                return Promise.resolve(soFar);
            }
        });
        const didItChange: Promise<Partial<Analysis>> = soLintIt.then(soFar =>
            soFar.project.gitStatus()
                .then(status => {
                    return ({ ...soFar, changed: !status.isClean, status });
                }));
        const letsPushIt: Promise<Analysis> = didItChange.then(soFar => {
            if (soFar.changed && soFar.personCares && soFar.happy) {
                return soFar.project.commit(CommitMessage)
                    .then(() => soFar.project.push())
                    .then(() => ({ ...soFar, pushed: true } as Analysis))
                    .catch(error => ({ ...soFar, pushed: false, error } as Analysis));
            } else {
                return Promise.resolve({ ...soFar, pushed: false } as Analysis);
            }
        });

        return letsPushIt
            .then(analysis => this.sendNotification(params.githubToken, ctx, push, analysis))
            .catch(error => reportError(ctx, push, error));
    }

    private sendNotification(token: string, ctx: HandlerContext, push: graphql.PushToTsLinting.Push,
                             analysis: Analysis): Promise<any> {

        const whoami = `${configuration.name}:${configuration.version}`;

        function reportToMe(notification: string) {
            const details: slack.SlackMessage = {
                text: `${analysis.author} made ${linkToCommit(push)} to ${push.branch}`,
                attachments: [
                    {
                        fallback: "did stuff",
                        text: notification,
                        footer: whoami,
                    }
                    , formatAnalysis(ctx, analysis)],
            };

            return ctx.messageClient.addressUsers(
                details,
                me, { id: ctx.correlationId, ts: 2 });
        }

        if (!analysis.lintable) {
            logger.info("Nothing to do on project " + push.repo + ", not lintable");
            return reportToMe("nothing");
        }
        if (analysis.pushed && analysis.happy) {
            // we are so useful
            return ctx.messageClient.addressUsers(
                `FYI, I fixed linting errors on your branch ${push.branch} because ${linkToCommit(push, "your commit")} failed linting. Please pull.`,
                analysis.author)
                .then(() => reportToMe("I told them they should pull"));
        }
        if (analysis.happy && analysis.changed && !analysis.personCares) {
            return reportToMe(`I could have fixed it, but didn't because ${analysis.author} didn't want me to`);
        }
        if (!analysis.pushed && !analysis.happy) {

            return problemsToAttachments(token, push, analysis.problems)
                .then(attachments =>
                    ctx.messageClient.addressUsers({
                            text:
                                `Bad news: there are some tricky linting errors on ${
                                    linkToCommit(push, "your commit")} to ${push.repo.name}#${push.branch}.`,
                            attachments,
                        },
                        analysis.author))
                .then(() => reportToMe("I told them to fix it themselves"));
        }
        // OK I'm not handling the other cases. Tell me about it.
        return reportToMe("I did nothing");
    }
}

function formatAnalysis(ctx: HandlerContext, analysis: Analysis): slack.Attachment {
    return {
        fallback: "analysis goes here",
        text: analysis.problems ? analysis.problems.map(formatProblem).join("\n") : "No problems",
        fields: fields(["author", "personCares", "lintable", "happy", "changed", "pushed"],
            ["status.raw", "error"], analysis),
        footer: ctx.correlationId,
    };
}

function fields(shortOnes: string[], longOnes: string[], source: object) {
    const shorts = shortOnes.map(f => ({ title: f, value: stringify(_.get(source, f, "undefined")), short: true }));
    const longs = longOnes.map(f => ({ title: f, value: stringify(_.get(source, f, "undefined")), short: false }));

    return shorts.concat(longs);
}

function initialReport(ctx: HandlerContext, push: graphql.PushToTsLinting.Push, author: string) {
    const whoami = `${configuration.name}:${configuration.version}`;

    ctx.messageClient.addressUsers(
        `${whoami}: ${author} made ${linkToCommit(push)}, message \`${push.after.message}\`. Linting`, me,
        { id: ctx.correlationId, ts: 1 });
}

function reportError(ctx: HandlerContext, push: graphql.PushToTsLinting.Push, error: Error) {
    ctx.messageClient.addressUsers(`Uncaught error while linting ${linkToCommit(push)}: ` + error, me);
}

function linkToCommit(push: graphql.PushToTsLinting.Push, text: string = `commit on ${push.repo.name}#${push.branch}`) {
    return slack.url(
        `https://github.com/${push.repo.owner}/${push.repo.name}/commit/${push.after.sha}`,
        text);
}

function urlToLine(push: graphql.PushToTsLinting.Push, location: Location) {
    return `https://github.com/${push.repo.owner}/${push.repo.name}/blob/${push.after.sha}/${location.path}#L${location.lineFrom1}`;
}

function linkToLine(push: graphql.PushToTsLinting.Push, location: Location) {
    return slack.url(
        urlToLine(push, location),
        location.description);
}

interface Problem {
    text: string;
    location?: Location;
    recognizedError?: RecognizedError;
}

function formatProblem(problem: Problem): string {
    return problem.recognizedError ? slack.bold(problem.recognizedError.name) + "" : problem.text;
}

interface Location {
    readonly path: string;
    readonly lineFrom1: number;
    readonly columnFrom1: number;
    readonly description: string;
}

function locate(tsError: string): Location | undefined {
    const pathAndLine = /([^\s]+)\[(\d+), (\d+)\]/;
    const match = tsError.match(pathAndLine);
    if (!match) {
        return undefined;
    }
    return {
        path: match[1],
        lineFrom1: +match[2],
        columnFrom1: +match[3],
        description: match[0],
    };
}

function addLinkToProblem(push: graphql.PushToTsLinting.Push, tsError: string): string {
    const location = locate(tsError);
    if (!location) {
        return tsError;
    }
    return tsError.replace(location.description, linkToLine(push, location));
}

function problemsToAttachments(token: string, push: graphql.PushToTsLinting.Push, problems?: Problem[]): Promise<slack.Attachment[]> {
    if (!problems) {
        return Promise.resolve([]);
    }
    return Promise.all(problems.map(p => problemToAttachment(token, push, p)));
}

function problemToAttachment(token: string, push: graphql.PushToTsLinting.Push, problem: Problem): Promise<slack.Attachment> {
    const output: slack.Attachment = { fallback: "problem" };

    if (problem.location) {
        output.author_name = problem.location.description;
        output.author_link = urlToLine(push, problem.location);
    }
    if (problem.recognizedError) {
        output.title = problem.recognizedError.name + ": " + problem.recognizedError.description;
        output.color = problem.recognizedError.color;
    } else {
        output.text = problem.text;
    }

    if (problem.recognizedError && problem.location && problem.recognizedError.usefulToShowLine) {
        const where = { name: push.repo.name, owner: push.repo.owner, ref: push.after.sha };
        return getFileContent(token, where, problem.location.path).then(content => {
            output.text = "`" + getLine(content, problem.location.lineFrom1) + "`";
            return output;
        });
    } else {
        return Promise.resolve(output);
    }

}

function getLine(content: string, lineFrom1: number) {
    const lines = content.split("\n");
    if (lines.length < lineFrom1) {
        return `## oops, there are only ${lines.length} lines. Unable to retrieve line ${lineFrom1}`;
    }
    return lines[lineFrom1 - 1];
}

class RecognizedError {

    private static defaultOptions = {
        color: "#888888",
        usefulToShowLine: false,
    };

    public color: string;
    public usefulToShowLine: boolean;

    constructor(public name: string,
                public description: string,
                opts?: { color?: string, usefulToShowLine?: boolean }) {
        const fullOpts = {
            ...RecognizedError.defaultOptions,
            ...opts,
        };
        this.color = fullOpts.color;
        this.usefulToShowLine = fullOpts.usefulToShowLine;
    }
}

class CommentFormatError extends RecognizedError {

    public static Name = "comment-format";

    public static recognize(name: string, description: string): CommentFormatError | null {
        if (name === this.Name) {
            return new CommentFormatError(description);
        }
        return null;
    }

    constructor(description: string) {
        super(CommentFormatError.Name, description,
            { color: "#d84010", usefulToShowLine: true });
    }
}

function recognizeError(tsError: string): RecognizedError {
    // ERROR: (comment-format) test/passContextToClone/editorTest.ts[986, 15]: comment must start with a space
    const pathAndLine = /ERROR: \(([a-z-]+)\).*: (.*)$/;
    const match = tsError.match(pathAndLine);
    if (!match) {
        return undefined;
    }

    const name = match[1];
    const description = match[2];

    return CommentFormatError.recognize(name, description) || new RecognizedError(name, description);
}

function findComplaints(push: graphql.PushToTsLinting.Push, tslintOutput: string): Problem[] {
    if (!tslintOutput) {
        return undefined;
    }
    return tslintOutput
        .split("\n")
        .filter(s => s.match(/^ERROR: /))
        .map(p => ({
            text: addLinkToProblem(push, p),
            location: locate(p),
            recognizedError: recognizeError(p),
        }));
}
