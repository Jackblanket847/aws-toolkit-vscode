/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as admZip from 'adm-zip'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as vscode from 'vscode'
import { ext } from '../extensionGlobals'
import { getIdeProperties } from '../extensionUtilities'
import { makeTemporaryToolkitFolder, tryRemoveFolder } from '../filesystemUtilities'
import { getLogger } from '../logger'
import { HttpResourceFetcher } from '../resourcefetcher/httpResourceFetcher'
import * as telemetry from '../telemetry/telemetry'
import { ChildProcess } from '../utilities/childProcess'
import { Window } from '../vscode/window'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

export class InstallerError extends Error {}
export class InvalidPlatformError extends Error {}

interface Cli {
    command: {
        unix: string
        windows: string
    }
    source: {
        macos: string
        windows: string
        linux: string
    }
    manualInstallLink: string
    name: string
}

type AwsClis = 'aws' | 'ssm'

/**
 * CLIs and their full filenames and download paths for their respective OSes
 * TODO: Add SAM? Other CLIs?
 */
export const AWS_CLIS: { [cli in AwsClis]: Cli } = {
    aws: {
        command: {
            unix: path.join('AWSCLIV2', 'aws'),
            windows: path.join('AWSCLIV2', 'aws.exe'),
        },
        source: {
            macos: 'https://awscli.amazonaws.com/AWSCLIV2.pkg',
            windows: 'https://awscli.amazonaws.com/AWSCLIV2.msi',
            linux: 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip',
        },
        name: 'AWS',
        manualInstallLink: 'https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html',
    },
    ssm: {
        command: {
            unix: path.join('sessionmanagerplugin', 'bin', 'session-manager-plugin'),
            windows: path.join('sessionmanagerplugin', 'bin', 'session-manager-plugin.exe'),
        },
        source: {
            // use pkg: zip is unsigned
            macos: 'https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac/session-manager-plugin.pkg',
            // TODO: REPLACE
            windows:
                'https://REMOVED/plugin/1.2.269.0/windows/SessionManagerPlugin.zip',
            linux: 'https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb',
        },
        name: 'Session Manager Plugin',
        manualInstallLink:
            'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
    },
}

/**
 * Installs a selected CLI: wraps confirmation, cleanup, and telemetry logic.
 * @param cli CLI to install
 * @returns Dir containing CLI
 */
export async function installCli(cli: AwsClis, window: Window = Window.vscode()): Promise<string | undefined> {
    let result: telemetry.Result = 'Succeeded'

    let tempDir: string | undefined
    const manualInstall = localize('AWS.cli.manualInstall', 'Install manually...')
    try {
        const install = localize('AWS.generic.install', 'Install')
        const selection = await window.showInformationMessage(
            localize(
                'AWS.mde.installCliPrompt',
                '{0} could not find {1} CLI. Install a local copy?',
                localize('AWS.channel.aws.toolkit', '{0} Toolkit', getIdeProperties().company),
                AWS_CLIS[cli].name
            ),
            install,
            manualInstall
        )

        if (selection !== install) {
            if (selection === manualInstall) {
                vscode.env.openExternal(vscode.Uri.parse(AWS_CLIS[cli].manualInstallLink))
            }
            result = 'Cancelled'

            return undefined
        }

        tempDir = await makeTemporaryToolkitFolder()
        let cliPath: string
        switch (cli) {
            case 'aws':
                cliPath = await installAwsCli(tempDir)
                break
            case 'ssm':
                cliPath = await installSsmCli(tempDir)
                break
        }
        // validate
        if (!(await hasCliCommand(AWS_CLIS[cli], false))) {
            throw new InstallerError('Could not verify installed CLIs')
        }

        return cliPath
    } catch (err) {
        result = 'Failed'

        window
            .showErrorMessage(
                localize('AWS.cli.failedInstall', 'Installation of the {0} CLI failed.', AWS_CLIS[cli].name),
                manualInstall
            )
            .then(button => {
                if (button === manualInstall) {
                    vscode.env.openExternal(vscode.Uri.parse(AWS_CLIS[cli].manualInstallLink))
                }
            })

        throw err
    } finally {
        if (tempDir) {
            getLogger().info('Cleaning up installer...')
            // nonblocking: use `then`
            tryRemoveFolder(tempDir).then(success => {
                if (success) {
                    getLogger().info('Removed installer.')
                } else {
                    getLogger().error(`Failed to clean up installer in temp directory: ${tempDir}`)
                }
            })
        }

        telemetry.recordAwsInstallCli({
            result,
            cli,
        })
    }
}

/**
 * Returns a path to a runnable CLI. Returns global path, local path, or undefined in that order.
 * @param cli CLI to detect
 * @returns Executable path, or undefined if not available
 */
export async function getCliCommand(cli: Cli): Promise<string | undefined> {
    const globalCommand = await hasCliCommand(cli, true)

    return globalCommand ?? (await hasCliCommand(cli, false))
}

// export async function hardLinkToCliDir(dir: string, command: Cli): Promise<void> {
//     const existingPath = path.join(dir, getOsCommand(command))
//     const newPath = getCliPath(command)
//     return new Promise((resolve, reject) => {
//         getLogger().debug(`Attempting to hard link ${existingPath} to ${newPath}...`)
//         fs.link(existingPath, newPath, err => {
//             if (err) {
//                 const message = `Toolkit could not create a hard link for ${existingPath} to ${newPath}`
//                 getLogger().error(`${message}: %O`, err)
//                 reject(new InstallerError(message))
//             }
//             resolve()
//         })
//     })
// }

/**
 * Returns whether or not a command is accessible on the user's $PATH
 * @param command CLI Command name
 */
async function hasCliCommand(cli: Cli, global: boolean): Promise<string | undefined> {
    const command = global ? path.parse(getOsCommand(cli)).base : path.join(getToolkitLocalCliPath(), getOsCommand(cli))
    const result = await new ChildProcess(true, command, undefined, '--version').run()

    return result.exitCode === 0 ? command : undefined
}

function getOsCommand(cli: Cli): string {
    return process.platform === 'win32' ? cli.command.windows : cli.command.unix
}

function getOsCliSource(cli: Cli): string {
    switch (process.platform) {
        case 'win32':
            return cli.source.windows
        case 'darwin':
            return cli.source.macos
        case 'linux':
            return cli.source.linux
        default:
            throw new InvalidPlatformError(`Platform ${process.platform} is not supported for CLI autoinstallation.`)
    }
}

async function downloadCliSource(cli: Cli, tempDir: string): Promise<string> {
    const installerSource = getOsCliSource(cli)
    const destinationFile = path.join(tempDir, path.parse(getOsCliSource(cli)).base)
    const fetcher = new HttpResourceFetcher(installerSource, { showUrl: true })
    getLogger().info(`Downloading installer from ${installerSource}...`)
    await fetcher.get(destinationFile).done

    return destinationFile
}

async function installToolkitLocalMsi(msiPath: string): Promise<string> {
    if (process.platform !== 'win32') {
        throw new InvalidPlatformError(`Cannot install MSI files on operating system: ${process.platform}`)
    }
    const result = await new ChildProcess(
        true,
        'msiexec',
        undefined,
        '/a',
        msiPath,
        '/quiet',
        // use base dir: installer installs to ./Amazon/AWSCLIV2
        `TARGETDIR=${vscode.Uri.file(getToolkitCliDir()).fsPath}`
    ).run()
    if (result.exitCode !== 0) {
        throw new InstallerError(`Installation of MSI file ${msiPath} failed: Error Code ${result.exitCode}`)
    }

    return path.join(getToolkitCliDir(), getOsCommand(AWS_CLIS.aws))
}

async function installToolkitLocalPkg(pkgPath: string, ...args: string[]): Promise<string> {
    if (process.platform !== 'darwin') {
        throw new InvalidPlatformError(`Cannot install pkg files on operating system: ${process.platform}`)
    }
    const result = await new ChildProcess(true, 'installer', undefined, '--pkg', pkgPath, ...args).run()
    if (result.exitCode !== 0) {
        throw new InstallerError(`Installation of PKG file ${pkgPath} failed: Error Code ${result.exitCode}`)
    }

    return path.join(getToolkitCliDir(), getOsCommand(AWS_CLIS.aws))
}

/**
 * TODO: THIS REQUIRES SUDO!!! Potentially drop support or look into adding; unsure how we would handle having to input a password.
 */
async function installToolkitLocalLinuxAwsCli(archivePath: string): Promise<string> {
    if (process.platform !== 'linux') {
        throw new InvalidPlatformError(`Cannot use Linux installer on operating system: ${process.platform}`)
    }
    const dirname = path.join(path.parse(archivePath).dir, path.parse(archivePath).name)
    const installDir = path.join(getToolkitCliDir(), 'Amazon', 'AWSCLIV2')
    new admZip(archivePath).extractAllTo(dirname, true)
    const result = await new ChildProcess(
        true,
        'sh',
        undefined,
        path.join(dirname, 'aws', 'install'),
        '-i',
        installDir,
        '-b',
        installDir
    ).run()
    if (result.exitCode !== 0) {
        throw new InstallerError(
            `Installation of Linux CLI archive ${archivePath} failed: Error Code ${result.exitCode}`
        )
    }

    return path.join(getToolkitCliDir(), getOsCommand(AWS_CLIS.aws))
}

function getToolkitCliDir(): string {
    return path.join(ext.context.globalStoragePath, 'cli')
}

/**
 * Gets the toolkit local CLI path
 * Instantiated as a function instead of a const to prevent being called before `ext.context` is set
 */
function getToolkitLocalCliPath(): string {
    return path.join(getToolkitCliDir(), 'Amazon')
}

/**
 * TODO: AWS CLI install on Linux requires sudo!!!
 */
async function installAwsCli(tempDir: string): Promise<string> {
    const awsInstaller = await downloadCliSource(AWS_CLIS.aws, tempDir)
    fs.chmodSync(awsInstaller, 0o700)

    getLogger('channel').info(`Installing AWS CLI from ${awsInstaller} to ${getToolkitCliDir()}...`)
    switch (process.platform) {
        case 'win32': {
            return await installToolkitLocalMsi(awsInstaller)
        }
        case 'darwin': {
            // edit config file: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2-mac.html#cliv2-mac-install-cmd-current-user
            const xmlPath = path.join(tempDir, 'choices.xml')
            fs.writeFileSync(
                xmlPath,
                `<?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
                <array>
                <dict>
                    <key>choiceAttribute</key>
                    <string>customLocation</string>
                    <key>attributeSetting</key>
                    <string>${getToolkitLocalCliPath()}</string>
                    <key>choiceIdentifier</key>
                    <string>default</string>
                </dict>
                </array>
            </plist>`
            )
            // install
            return await installToolkitLocalPkg(
                awsInstaller,
                '--target',
                'CurrentUserHomeDirectory',
                '--applyChoiceChangesXML',
                xmlPath
            )
        }
        case 'linux': {
            return await installToolkitLocalLinuxAwsCli(awsInstaller)
        }
        default: {
            throw new InvalidPlatformError(`Unsupported platform for CLI installation: ${process.platform}`)
        }
    }
}

async function installSsmCli(tempDir: string): Promise<string> {
    const ssmInstaller = await downloadCliSource(AWS_CLIS.ssm, tempDir)
    const outDir = path.join(getToolkitLocalCliPath(), 'sessionmanagerplugin')

    getLogger('channel').info(`Installing SSM CLI from ${ssmInstaller} to ${outDir}...`)
    switch (process.platform) {
        case 'darwin': {
            return new Promise<string>(async (resolve, reject) => {
                try {
                    const tempPath = path.join(tempDir, 'tmp')
                    await new ChildProcess(
                        true,
                        'pkgutil',
                        { cwd: tempDir },
                        '--expand',
                        'session-manager-plugin.pkg',
                        tempPath
                    ).run()
                    await new ChildProcess(true, 'tar', { cwd: tempPath }, '-xzf', path.join(tempPath, 'Payload')).run()

                    fs.copySync(path.join(tempPath, 'usr', 'local', 'sessionmanagerplugin'), outDir, {
                        recursive: true,
                    })

                    resolve(path.join(outDir, 'bin'))
                } catch (err) {
                    reject(new InstallerError((err as Error).message))
                }
            })
        }
        case 'win32': {
            return new Promise<string>(async (resolve, reject) => {
                const secondZip = path.join(tempDir, 'package.zip')
                // first zip
                await new Promise<void>(resolve2 => {
                    try {
                        new admZip(ssmInstaller).extractAllTo(tempDir, true)
                        new admZip(secondZip).extractAllTo(outDir, true)

                        resolve(path.join(outDir, 'bin'))
                    } catch (err) {
                        if (err) {
                            reject(new InstallerError((err as Error).message))
                        }
                        resolve2()
                    }
                })
            })
        }
        case 'linux': {
            return new Promise<string>(async (resolve, reject) => {
                // extract deb file (using ar) to ssmInstaller dir
                await new ChildProcess(true, 'ar', { cwd: path.dirname(ssmInstaller) }, '-x', ssmInstaller).run()
                // extract data.tar.gz to CLI dir
                await new ChildProcess(
                    true,
                    'tar',
                    { cwd: path.dirname(ssmInstaller) },
                    '-xzf',
                    path.join(path.dirname(ssmInstaller), 'data.tar.gz')
                ).run()

                fs.mkdirSync(outDir, { recursive: true })
                fs.copySync(path.join(path.dirname(ssmInstaller), 'usr', 'local', 'sessionmanagerplugin'), outDir, {
                    recursive: true,
                })

                resolve(path.join(outDir, 'bin'))
            })
        }
        default: {
            throw new InvalidPlatformError(`Platform ${process.platform} is not supported for CLI autoinstallation.`)
        }
    }
}