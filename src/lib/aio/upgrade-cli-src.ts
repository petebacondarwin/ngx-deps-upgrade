/**
 * Upgrade the `@angular/cli` sources used to build cli commands docs for `angular.io`.
 */
import {writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join, parse} from 'path';
import * as sh from 'shelljs';
import {BaseUpgradelet} from '../utils/base-upgradelet';
import {GH_TOKEN, REPO_INFO, USER_INFO} from '../utils/constants';
import {GitRepo} from '../utils/git-repo';
import {GithubRepo, IPullRequest, IPullRequestSearchParams} from '../utils/github-repo';

sh.set('-e');

interface IUpgradeCheckResults {
  currentSha: string;
  latestSha: string;
  needsUpgrade: boolean;
}

export class Upgradelet extends BaseUpgradelet {
  private static readonly CB_REPO_NAME = 'cli-builds';
  private static readonly AIO_PKG_PATH = 'aio/package.json';
  private static readonly AIO_SCRIPT_NAME = 'extract-cli-command-docs';
  private static readonly AIO_SCRIPT_RE = /^node \S+ ([\da-f]+)$/;
  private static readonly LOCAL_BRANCH_PREFIX = parse(__filename).name;
  private static readonly COMMIT_MESSAGE_PREFIX = 'build(docs-infra): upgrade cli command docs sources to ';
  private static readonly CREDENTIALS_PATH = join(tmpdir(), `.git-credentials--${Upgradelet.LOCAL_BRANCH_PREFIX}`);
  private static readonly PR_LABELS = [
    'comp: build & ci',
    'comp: docs-infra',
    'PR action: review',
    'PR target: TBD',
  ];
  private static readonly REPORT_ERRORS = !!process.env.CI;

  private readonly upstreamRepo =
      new GithubRepo(this.utils.githubUtils, REPO_INFO.ng.upstreamOwner, REPO_INFO.ng.upstreamName);
  private readonly originRepo =
      new GithubRepo(this.utils.githubUtils, REPO_INFO.ng.originOwner, REPO_INFO.ng.upstreamName);
  private readonly cliBuildsRepo =
      new GithubRepo(this.utils.githubUtils, REPO_INFO.ng.upstreamOwner, Upgradelet.CB_REPO_NAME);

  public async checkAndUpgrade({branch = REPO_INFO.ng.defaultBranch}): Promise<void> {
    try {
      this.utils.logger.info(`Checking and upgrading cli command docs sources for angular.io.`);

      const {currentSha, latestSha, needsUpgrade} = await this.checkNeedsUpgrade(branch);

      if (!needsUpgrade) {
        const reason = this.shasMatch(currentSha, latestSha) ?
          `Already using the latest SHA (${currentSha}).` :
          `No 'help/**' files changed between ${currentSha} and ${latestSha}.`;
        this.utils.logger.info(`No upgrade needed. ${reason}`);
        return;
      }

      this.utils.logger.info(`Upgrade needed: ${currentSha} --> ${latestSha}`);

      const localBranch = `${Upgradelet.LOCAL_BRANCH_PREFIX}--${branch}--${latestSha}`;
      const commitMsgSubject = `${Upgradelet.COMMIT_MESSAGE_PREFIX}${latestSha}`;
      const localRepo = this.initLocalRepo();

      // Update/Clean up old PRs.
      const relevantBranches = localRepo.
        getRemoteBranches(GitRepo.ORIGIN).
        filter(branchName => branchName.startsWith(Upgradelet.LOCAL_BRANCH_PREFIX));
      const openPrsPerBranch = await this.getOpenPrsPerBranch(relevantBranches);
      const relevantBranchesWithOpenPrs = Array.from(openPrsPerBranch.keys());

      this.cleanupObsoleteBranches(localRepo, relevantBranches, relevantBranchesWithOpenPrs);

      // Check if PR for `latestSha` already exists.
      if (relevantBranchesWithOpenPrs.includes(localBranch)) {
        const existingPrs = openPrsPerBranch.get(localBranch)!;
        const existingPrsStr = existingPrs.map(pr => `  #${pr.number} (${pr.html_url})`).join('\n');
        this.utils.logger.info(`PR for latest SHA (${latestSha}) already exists:\n${existingPrsStr}`);
        return;
      }

      // Make changes.
      this.createLocalBranch(localRepo, localBranch, branch);
      this.makeChanges(localRepo, currentSha, latestSha);

      // Submit PR.
      const supercededPrs = Array.from(openPrsPerBranch.values()).reduce((aggr, prs) => aggr.concat(prs), []);
      const commitMsg = `${commitMsgSubject}\n\n${supercededPrs.map(pr => `Closes #${pr.number}`).join('\n')}`.trim();
      this.commitAndPush(localRepo, commitMsg);
      const newPr = await this.submitPullRequest(localBranch, branch, commitMsgSubject);

      // Comment on superceded PRs.
      // (Do not close them, in case the latest SHA is broken.)
      await this.ignoreError(() => this.commentOnSupercededPrs(supercededPrs, newPr));

      // Perform local clean-up.
      await this.ignoreError(() => localRepo.destroy());

      this.utils.logger.info(`Upgrade completed successfully \\o/ | PR: #${newPr.number} (${newPr.html_url})`);
    } catch (err) {
      await this.ignoreError(() => sh.rm('-f', Upgradelet.CREDENTIALS_PATH));
      await this.ignoreError(() => this.reportError('checking and upgrading', err));
      throw err;
    }
  }

  public async checkOnly({branch = REPO_INFO.ng.defaultBranch}): Promise<boolean> {
    try {
      this.utils.logger.info(`Checking cli command docs sources for angular.io.`);
      return !(await this.checkNeedsUpgrade(branch)).needsUpgrade;
    } catch (err) {
      await this.ignoreError(() => this.reportError('checking only', err));
      throw err;
    }
  }

  private async checkNeedsUpgrade(branch: string): Promise<IUpgradeCheckResults> {
    const currentSha = await this.retrieveShaFromAio(branch);
    const latestSha = await this.retrieveShaFromCliBuilds(branch);
    let needsUpgrade = !this.shasMatch(currentSha, latestSha);

    if (needsUpgrade) {
      const affectedFiles = await this.cliBuildsRepo.getAffectedFiles(currentSha, latestSha);
      const didHelpChange = affectedFiles.some(file => file.filename.startsWith('help/'));
      needsUpgrade = didHelpChange;
    }

    return {currentSha, latestSha, needsUpgrade};
  }

  private cleanupObsoleteBranches(localRepo: GitRepo, branches: string[], branchesWithOpenPrs: string[]): void {
    const branchesWithoutOpenPrs = branches.filter(branch => !branchesWithOpenPrs.includes(branch));
    branchesWithoutOpenPrs.forEach(branch => localRepo.deleteRemoteBranch(GitRepo.ORIGIN, branch));
  }

  private async commentOnSupercededPrs(supercededPrs: IPullRequest[], newPr: IPullRequest): Promise<void> {
    const supercededComment = `Superceded by #${newPr.number}.`;
    await Promise.all(supercededPrs.map(pr => this.upstreamRepo.comment(pr.number, supercededComment)));
  }

  private commitAndPush(localRepo: GitRepo, commitMsg: string): void {
    this.utils.logger.info(`  Commiting changes and pushing to '${GitRepo.ORIGIN}'.`);

    localRepo.commit(commitMsg, {all: true});
    localRepo.fetch(GitRepo.ORIGIN, {unshallow: true});
    localRepo.push(GitRepo.ORIGIN, {force: true});
  }

  private createLocalBranch(localRepo: GitRepo, localBranch: string, branch: string): void {
    this.utils.logger.info(`  Creating local branch '${localBranch}' from '${this.upstreamRepo.slug}#${branch}'.`);

    localRepo.fetch(GitRepo.UPSTREAM, branch, {depth: '1'});
    localRepo.checkout('FETCH_HEAD', {b: localBranch});
  }

  private async getOpenPrsPerBranch(branches: string[]): Promise<Map<string, IPullRequest[]>> {
    const prsForBranches = await Promise.all(branches.
      map(branch => ({head: `${this.originRepo.owner}:${branch}`, state: 'all'} as IPullRequestSearchParams)).
      map(searchParams => this.upstreamRepo.getPullRequests(searchParams)));

    const relevantPrsForBracnhes = prsForBranches.
      map(prsForBranch => prsForBranch.filter(({title}) => title.startsWith(Upgradelet.COMMIT_MESSAGE_PREFIX)));

    const entries = branches.
      map<[string, IPullRequest[]]>((branch, i) => [
        branch,
        relevantPrsForBracnhes[i].filter(({state}) => state === 'open'),
      ]).
      filter(([_, prs]) => prs.length > 0);

    return new Map(entries);
  }

  private async ignoreError(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.utils.logger.warn(err);
    }
  }

  private initLocalRepo(): GitRepo {
    const localRepoDir = join(tmpdir(), this.originRepo.name);

    this.utils.logger.info(`  Initializing local '${this.originRepo.slug}' copy in '${localRepoDir}'.`);

    sh.rm('-rf', localRepoDir);
    sh.mkdir('-p', localRepoDir);

    const localRepo = new GitRepo(this.utils.logger, localRepoDir);

    localRepo.init();
    localRepo.addRemote(GitRepo.ORIGIN, this.originRepo.url);
    localRepo.addRemote(GitRepo.UPSTREAM, this.upstreamRepo.url);

    if (process.env.CI) {
      this.utils.logger.info(`  Configuring local git repo on CI (user.name, user.email, credentials).`);

      writeFileSync(Upgradelet.CREDENTIALS_PATH, `https://${GH_TOKEN}:@github.com`);
      sh.chmod('go-rwx', Upgradelet.CREDENTIALS_PATH);

      localRepo.config('credential.helper', `"store --file=${Upgradelet.CREDENTIALS_PATH}"`);
      localRepo.config('user.name', `"${USER_INFO.name}"`);
      localRepo.config('user.email', `"${USER_INFO.email}"`);
    }

    return localRepo;
  }

  private makeChanges(localRepo: GitRepo, currentSha: string, latestSha: string): void {
    this.utils.logger.info(`  Changing '${currentSha}' to '${latestSha}' in '${Upgradelet.AIO_PKG_PATH}'.`);
    sh.sed('-i', new RegExp(currentSha, 'g'), latestSha, join(localRepo.directory, Upgradelet.AIO_PKG_PATH));
  }

  private async reportError(action: string, err: unknown): Promise<void> {
    if (!Upgradelet.REPORT_ERRORS) {
      return;
    }

    this.utils.logger.info(`  Reporting error while ${action}.`);

    const codeBlock = (header: string, code: string) =>
      `**${header}:**\n\`\`\`\n${code}\n\`\`\`\n`;

    const title = `[${Upgradelet.LOCAL_BRANCH_PREFIX}] Error while ${action}`;
    const body =
        codeBlock('Error', this.stringifyError(err)) +
        '\n##\n' +
        codeBlock('Logs', this.utils.logger.getLogs().join('\n'));

    const thisRepo = new GithubRepo(this.utils.githubUtils, REPO_INFO.own.originOwner, REPO_INFO.own.originName);
    await thisRepo.createIssue(title, body);
  }

  private async retrieveShaFromAio(branch: string): Promise<string> {
    const source = `${this.upstreamRepo.slug}/${Upgradelet.AIO_PKG_PATH}#${branch}`;

    this.utils.logger.info(`  Extracting the current SHA for cli sources from '${source}'.`);

    const pkgJson = await this.upstreamRepo.getFileContents(Upgradelet.AIO_PKG_PATH, branch);
    const scripts: {[key: string]: string} = JSON.parse(pkgJson).scripts;
    const cliSrcScript = scripts[Upgradelet.AIO_SCRIPT_NAME];
    const cliSrcShaMatch = Upgradelet.AIO_SCRIPT_RE.exec(cliSrcScript);

    if (!cliSrcScript || !cliSrcShaMatch) {
      throw new Error(
          `Unable to extract the SHA for cli sources from '${source}'.\n` +
          `The '${Upgradelet.AIO_SCRIPT_NAME}' script is missing or has unexpected format.`);
    }

    return cliSrcShaMatch[1];
  }

  private async retrieveShaFromCliBuilds(branch: string): Promise<string> {
    const source = `${this.cliBuildsRepo.slug}#${branch}`;

    this.utils.logger.info(`  Extracting the latest SHA for cli sources from '${source}'.`);

    const cliSrcSha = await this.cliBuildsRepo.getLatestSha(branch);

    if (!cliSrcSha) {
      throw new Error(
          `Unable to extract the SHA for cli sources from '${source}'.\n` +
          `The SHA is empty.`);
    }

    return cliSrcSha.slice(0, 9);
  }

  private shasMatch(sha1: string, sha2: string): boolean {
    return sha1.startsWith(sha2) || sha2.startsWith(sha1);
  }

  private stringifyError(err: any): string {
    if (err instanceof Error) {
      return err.stack || err.message;
    }

    try {
      return JSON.stringify(err);
    } catch {
      return `${err}`;
    }
  }

  private async submitPullRequest(originBranch: string, upstreamBranch: string, title: string): Promise<IPullRequest> {
    const src = `${this.originRepo.slug}#${originBranch}`;
    const dst = `${this.upstreamRepo.slug}#${upstreamBranch}`;

    this.utils.logger.info(`  Submitting pull request from '${src}' to '${dst}'.`);

    const head = `${this.originRepo.owner}:${originBranch}`;
    const pr = await this.upstreamRepo.createPullRequest(head, upstreamBranch, title);

    await this.ignoreError(() => this.upstreamRepo.addLabels(pr.number, Upgradelet.PR_LABELS));

    return pr;
  }
}

if (require.main === module) {
  Upgradelet.main();
}