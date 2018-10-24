import {basename} from 'path';
import * as sh from 'shelljs';
import {Logger} from './logger';

export interface ICommnandOptions {
  [key: string]: boolean | string | string[];
}

export class GitRepo {
  public static readonly ORIGIN = 'origin';
  public static readonly UPSTREAM = 'upstream';

  public get currentBranch(): string {
    return this.execInRepo('git rev-parse --abbrev-ref HEAD').toString().trim();
  }
  public readonly name = basename(this.directory);
  private destroyed = false;

  constructor(private readonly logger: Logger, readonly directory: string) {
  }

  public addRemote(name: string, url: string): void {
    this.execInRepo(`git remote remove ${name} || true`);
    this.execInRepo(`git remote add ${name} ${url}`);
  }

  public checkout(ref: string, opts?: ICommnandOptions): void {
    this.execInRepo(`git checkout ${ref}`, opts);
  }

  public commit(msg: string, opts?: ICommnandOptions): void {
    this.execInRepo(`git commit`, {...opts, message: msg.split(/\r?\n/).map(m => `"${m}"`)});
  }

  public config(key: string, value: string): void {
    this.execInRepo(`git config ${key} ${value}`);
  }

  public deleteRemoteBranch(remote: string, branch: string, opts?: ICommnandOptions): void {
    this.push(remote, '', branch);
  }

  public fetch(remote: string, opts?: ICommnandOptions): void;
  public fetch(remote: string, branch: string, opts?: ICommnandOptions): void;
  public fetch(remote: string, branch?: string | ICommnandOptions, opts?: ICommnandOptions): void {
    if (typeof branch !== 'string') {
      opts = branch;
      branch = '';
    }

    this.execInRepo(`git fetch ${remote} ${branch}`, opts);
  }

  public getRemoteBranches(remote: string): string[] {
    this.fetch(remote, {depth: '1', 'no-tags': true});
    const {stdout: branchesOutput} = this.execInRepo(`git branch`, {remote: true});

    return branchesOutput.
      split('\n').
      map(line => line.trim()).
      filter(line => line.startsWith(`${remote}/`)).
      map(line => line.replace(new RegExp(`^${remote}/`), ''));
  }

  public init(opts?: ICommnandOptions): void {
    this.execInRepo('git init', opts);
  }

  public push(remote: string, opts?: ICommnandOptions): void;
  public push(remote: string, remoteBranch: string, opts?: ICommnandOptions): void;
  public push(remote: string, localBranch: string, remoteBranch: string, opts?: ICommnandOptions): void;
  public push(
      remote: string,
      localBranch?: string | ICommnandOptions,
      remoteBranch?: string | ICommnandOptions,
      opts?: ICommnandOptions,
  ): void {
    if (typeof localBranch !== 'string') {
      opts = localBranch;
      remoteBranch = localBranch = this.currentBranch;
    } else if (typeof remoteBranch !== 'string') {
      opts = remoteBranch;
      remoteBranch = localBranch;
      localBranch = this.currentBranch;
    }

    this.execInRepo(`git push ${remote} ${localBranch}:${remoteBranch}`, opts);
  }

  public destroy(): void {
    if (!this.destroyed) {
      sh.rm('-rf', this.directory);
      this.destroyed = true;
    }
  }

  private execInRepo(partialCmd: string, opts?: ICommnandOptions): sh.ExecOutputReturnValue {
    if (this.destroyed) {
      throw new Error('Repository already destroyed.');
    }

    try {
      sh.pushd('-q', this.directory);

      const cmd = this.withOptions(partialCmd.trim(), opts);
      this.logger.debug(`GIT: ${cmd}`);

      const result = sh.exec(cmd, {silent: true}) as sh.ExecOutputReturnValue;

      result.stdout.
        split('\n').
        filter(line => line.trim()).
        map(line => this.logger.debug(`GIT: ${line}`));

      return result;
    } finally {
      sh.popd('-q');
    }
  }

  private withOptions(cmd: string, opts?: ICommnandOptions): string {
    const optsStr = opts && Object.keys(opts).
      filter(key => opts[key] !== false).
      map(key => {
        const name = (key.length === 1) ? `-${key}` : `--${key}`;
        const rawValue = (opts[key] === true) ? '' : opts[key] as string | string[];
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];

        return values.map(value => `${name} ${value}`.trim()).join(' ');
      }).
      join(' ');

    return optsStr ? `${cmd} ${optsStr}` : cmd;
  }
}