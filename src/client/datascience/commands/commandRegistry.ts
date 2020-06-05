// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable, multiInject, named, optional } from 'inversify';
import {
    CodeLens,
    ConfigurationTarget,
    env,
    QuickPickItem,
    QuickPickOptions,
    Range,
    SaveDialogOptions,
    Uri
} from 'vscode';
import { ICommandNameArgumentTypeMapping } from '../../common/application/commands';
import { IApplicationShell, ICommandManager, IDebugService, IDocumentManager } from '../../common/application/types';
import { Commands as coreCommands } from '../../common/constants';
import { IStartPage } from '../../common/startPage/types';
import { IConfigurationService, IDisposable, IOutputChannel } from '../../common/types';
import { DataScience } from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { Commands, JUPYTER_OUTPUT_CHANNEL, Telemetry } from '../constants';
import {
    ICodeWatcher,
    IDataScienceCodeLensProvider,
    IDataScienceCommandListener,
    INotebookEditorProvider
} from '../types';
import { JupyterCommandLineSelectorCommand } from './commandLineSelector';
import { KernelSwitcherCommand } from './kernelSwitcher';
import { JupyterServerSelectorCommand } from './serverSelector';

interface IExportQuickPickItem extends QuickPickItem {
    handler(): void;
}

@injectable()
export class CommandRegistry implements IDisposable {
    private readonly disposables: IDisposable[] = [];
    constructor(
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IDataScienceCodeLensProvider) private dataScienceCodeLensProvider: IDataScienceCodeLensProvider,
        @multiInject(IDataScienceCommandListener)
        @optional()
        private commandListeners: IDataScienceCommandListener[] | undefined,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(JupyterServerSelectorCommand) private readonly serverSelectedCommand: JupyterServerSelectorCommand,
        @inject(KernelSwitcherCommand) private readonly kernelSwitcherCommand: KernelSwitcherCommand,
        @inject(JupyterCommandLineSelectorCommand)
        private readonly commandLineCommand: JupyterCommandLineSelectorCommand,
        @inject(INotebookEditorProvider) private notebookEditorProvider: INotebookEditorProvider,
        @inject(IDebugService) private debugService: IDebugService,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private appShell: IApplicationShell,
        @inject(IOutputChannel) @named(JUPYTER_OUTPUT_CHANNEL) private jupyterOutput: IOutputChannel,
        @inject(IStartPage) private startPage: IStartPage,
        @inject(IApplicationShell) private applicationShell: IApplicationShell
    ) {
        this.disposables.push(this.serverSelectedCommand);
        this.disposables.push(this.kernelSwitcherCommand);
    }
    public register() {
        this.commandLineCommand.register();
        this.serverSelectedCommand.register();
        this.kernelSwitcherCommand.register();
        this.registerCommand(Commands.RunAllCells, this.runAllCells);
        this.registerCommand(Commands.RunCell, this.runCell);
        this.registerCommand(Commands.RunCurrentCell, this.runCurrentCell);
        this.registerCommand(Commands.RunCurrentCellAdvance, this.runCurrentCellAndAdvance);
        this.registerCommand(Commands.ExecSelectionInInteractiveWindow, this.runSelectionOrLine);
        this.registerCommand(Commands.RunAllCellsAbove, this.runAllCellsAbove);
        this.registerCommand(Commands.RunCellAndAllBelow, this.runCellAndAllBelow);
        this.registerCommand(Commands.RunAllCellsAbovePalette, this.runAllCellsAboveFromCursor);
        this.registerCommand(Commands.RunCellAndAllBelowPalette, this.runCellAndAllBelowFromCursor);
        this.registerCommand(Commands.RunToLine, this.runToLine);
        this.registerCommand(Commands.RunFromLine, this.runFromLine);
        this.registerCommand(Commands.RunFileInInteractiveWindows, this.runFileInteractive);
        this.registerCommand(Commands.DebugFileInInteractiveWindows, this.debugFileInteractive);
        this.registerCommand(Commands.AddCellBelow, this.addCellBelow);
        this.registerCommand(Commands.RunCurrentCellAndAddBelow, this.runCurrentCellAndAddBelow);
        this.registerCommand(Commands.DebugCell, this.debugCell);
        this.registerCommand(Commands.DebugStepOver, this.debugStepOver);
        this.registerCommand(Commands.DebugContinue, this.debugContinue);
        this.registerCommand(Commands.DebugStop, this.debugStop);
        this.registerCommand(Commands.DebugCurrentCellPalette, this.debugCurrentCellFromCursor);
        this.registerCommand(Commands.CreateNewNotebook, this.createNewNotebook);
        this.registerCommand(Commands.ViewJupyterOutput, this.viewJupyterOutput);
        this.registerCommand(Commands.ExportAsPythonScript, this.exportAsPythonScript);
        this.registerCommand(Commands.ExportToHTML, this.exportToHTML);
        this.registerCommand(Commands.ExportToPDF, this.exportToPDF);
        this.registerCommand(Commands.Export, this.export);
        this.registerCommand(Commands.GatherQuality, this.reportGatherQuality);
        this.registerCommand(
            Commands.EnableLoadingWidgetsFrom3rdPartySource,
            this.enableLoadingWidgetScriptsFromThirdParty
        );
        this.registerCommand(coreCommands.OpenStartPage, this.openStartPage);
        if (this.commandListeners) {
            this.commandListeners.forEach((listener: IDataScienceCommandListener) => {
                listener.register(this.commandManager);
            });
        }
    }
    public dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
    private registerCommand<
        E extends keyof ICommandNameArgumentTypeMapping,
        U extends ICommandNameArgumentTypeMapping[E]
        // tslint:disable-next-line: no-any
    >(command: E, callback: (...args: U) => any) {
        const disposable = this.commandManager.registerCommand(command, callback, this);
        this.disposables.push(disposable);
    }

    private getCodeWatcher(file: string): ICodeWatcher | undefined {
        const possibleDocuments = this.documentManager.textDocuments.filter((d) => d.fileName === file);
        if (possibleDocuments && possibleDocuments.length === 1) {
            return this.dataScienceCodeLensProvider.getCodeWatcher(possibleDocuments[0]);
        } else if (possibleDocuments && possibleDocuments.length > 1) {
            throw new Error(DataScience.documentMismatch().format(file));
        }

        return undefined;
    }

    private enableLoadingWidgetScriptsFromThirdParty(): void {
        if (this.configService.getSettings(undefined).datascience.widgetScriptSources.length > 0) {
            return;
        }
        // Update the setting and once updated, notify user to restart kernel.
        this.configService
            .updateSetting(
                'dataScience.widgetScriptSources',
                ['jsdelivr.com', 'unpkg.com'],
                undefined,
                ConfigurationTarget.Global
            )
            .then(() => {
                // Let user know they'll need to restart the kernel.
                this.appShell
                    .showInformationMessage(DataScience.loadThirdPartyWidgetScriptsPostEnabled())
                    .then(noop, noop);
            })
            .catch(noop);
    }

    private async runAllCells(file: string): Promise<void> {
        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.runAllCells();
        } else {
            return Promise.resolve();
        }
    }

    private async runFileInteractive(file: string): Promise<void> {
        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.runFileInteractive();
        } else {
            return Promise.resolve();
        }
    }

    private async debugFileInteractive(file: string): Promise<void> {
        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.debugFileInteractive();
        } else {
            return Promise.resolve();
        }
    }

    // Note: see codewatcher.ts where the runcell command args are attached. The reason we don't have any
    // objects for parameters is because they can't be recreated when passing them through the LiveShare API
    private async runCell(
        file: string,
        startLine: number,
        startChar: number,
        endLine: number,
        endChar: number
    ): Promise<void> {
        const codeWatcher = this.getCodeWatcher(file);
        if (codeWatcher) {
            return codeWatcher.runCell(new Range(startLine, startChar, endLine, endChar));
        }
    }

    private async runAllCellsAbove(file: string, stopLine: number, stopCharacter: number): Promise<void> {
        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.runAllCellsAbove(stopLine, stopCharacter);
            }
        }
    }

    private async runCellAndAllBelow(file: string, startLine: number, startCharacter: number): Promise<void> {
        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.runCellAndAllBelow(startLine, startCharacter);
            }
        }
    }

    private async runToLine(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        const textEditor = this.documentManager.activeTextEditor;

        if (activeCodeWatcher && textEditor && textEditor.selection) {
            return activeCodeWatcher.runToLine(textEditor.selection.start.line);
        }
    }

    private async runFromLine(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        const textEditor = this.documentManager.activeTextEditor;

        if (activeCodeWatcher && textEditor && textEditor.selection) {
            return activeCodeWatcher.runFromLine(textEditor.selection.start.line);
        }
    }

    private async runCurrentCell(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCell();
        } else {
            return Promise.resolve();
        }
    }

    private async runCurrentCellAndAdvance(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCellAndAdvance();
        } else {
            return Promise.resolve();
        }
    }

    private async runSelectionOrLine(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runSelectionOrLine(this.documentManager.activeTextEditor);
        } else {
            return Promise.resolve();
        }
    }

    private async debugCell(
        file: string,
        startLine: number,
        startChar: number,
        endLine: number,
        endChar: number
    ): Promise<void> {
        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.debugCell(new Range(startLine, startChar, endLine, endChar));
            }
        }
    }

    @captureTelemetry(Telemetry.DebugStepOver)
    private async debugStepOver(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.stepOver');
        }
    }

    @captureTelemetry(Telemetry.DebugStop)
    private async debugStop(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.stop');
        }
    }

    @captureTelemetry(Telemetry.DebugContinue)
    private async debugContinue(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.continue');
        }
    }
    @captureTelemetry(Telemetry.AddCellBelow)
    private async addCellBelow(): Promise<void> {
        const activeEditor = this.documentManager.activeTextEditor;
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeEditor && activeCodeWatcher) {
            return activeCodeWatcher.addEmptyCellToBottom();
        }
    }
    private async runCurrentCellAndAddBelow(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCellAndAddBelow();
        } else {
            return Promise.resolve();
        }
    }

    private async runAllCellsAboveFromCursor(): Promise<void> {
        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.runAllCellsAbove(
                    currentCodeLens.range.start.line,
                    currentCodeLens.range.start.character
                );
            }
        } else {
            return Promise.resolve();
        }
    }

    private async runCellAndAllBelowFromCursor(): Promise<void> {
        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.runCellAndAllBelow(
                    currentCodeLens.range.start.line,
                    currentCodeLens.range.start.character
                );
            }
        } else {
            return Promise.resolve();
        }
    }

    private async debugCurrentCellFromCursor(): Promise<void> {
        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.debugCurrentCell();
            }
        } else {
            return Promise.resolve();
        }
    }

    private async createNewNotebook(): Promise<void> {
        await this.notebookEditorProvider.createNew();
    }

    private async openStartPage(): Promise<void> {
        await this.startPage.open();
    }

    private viewJupyterOutput() {
        this.jupyterOutput.show(true);
    }

    private getExportQuickPickItems(): IExportQuickPickItem[] {
        // To add a new quick pick item simply enter the label,
        // if it picked by default and add a handler for when it is selected
        return [
            { label: 'Python Script', picked: true, handler: this.exportAsPythonScript },
            { label: 'HTML', picked: false, handler: this.exportToHTML },
            { label: 'PDF', picked: false, handler: this.exportToPDF }
        ];
    }

    private exportAsPythonScript() {}

    private exportToHTML() {}

    private exportToPDF() {}

    private async showExportQuickPick(): Promise<IExportQuickPickItem | undefined> {
        const items = this.getExportQuickPickItems();

        const options: QuickPickOptions = {
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: 'Export As...'
        };

        const pickedItem = await this.applicationShell.showQuickPick(items, options);
        if (!pickedItem) {
            return;
        }
        for (const item of items) {
            if (item.label === pickedItem.label) {
                return item;
            }
        }
    }

    private getFileSaveLocation(): Uri | undefined {
        const file = this.notebookEditorProvider.activeEditor?.file;
        const options: SaveDialogOptions = {
            defaultUri: file,
            saveLabel: '',
            filters: {
                'Juypter Notebooks': ['ipynb']
            }
        };

        this.applicationShell.showSaveDialog(options).then((uri) => {
            return uri;
        });
        return undefined;
    }

    private verifySaved() {
        if (this.notebookEditorProvider.activeEditor?.isUntitled) {
            // save to temporary file, don't need to ask
            return;
        }

        if (!this.notebookEditorProvider.activeEditor?.isDirty) {
            // if notebook does not have unsaved changed
            return;
        }

        // Ask user if they'd like to save
        const yes = DataScience.exportSaveFileYes();
        const cancel = DataScience.exportSaveFileCancel();
        const options = [yes, cancel];

        this.applicationShell.showInformationMessage(DataScience.exportSaveFilePrompt(), ...options).then((choice) => {
            if (choice === yes) {
                const file = this.getFileSaveLocation();
            }
        });
    }

    private export() {
        // shows the export quick pick menu
        this.showExportQuickPick()
            .then((item) => {
                this.verifySaved(); // make sure notebook file is saved
                item?.handler();
            })
            .catch();
    }

    private getCurrentCodeLens(): CodeLens | undefined {
        const activeEditor = this.documentManager.activeTextEditor;
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeEditor && activeCodeWatcher) {
            // Find the cell that matches
            return activeCodeWatcher.getCodeLenses().find((c: CodeLens) => {
                if (
                    c.range.end.line >= activeEditor.selection.anchor.line &&
                    c.range.start.line <= activeEditor.selection.anchor.line
                ) {
                    return true;
                }
                return false;
            });
        }
    }
    // Get our matching code watcher for the active document
    private getCurrentCodeWatcher(): ICodeWatcher | undefined {
        const activeEditor = this.documentManager.activeTextEditor;
        if (!activeEditor || !activeEditor.document) {
            return undefined;
        }

        // Ask our code lens provider to find the matching code watcher for the current document
        return this.dataScienceCodeLensProvider.getCodeWatcher(activeEditor.document);
    }

    private reportGatherQuality(val: string) {
        sendTelemetryEvent(Telemetry.GatherQualityReport, undefined, { result: val === 'no' ? 'no' : 'yes' });
        env.openExternal(Uri.parse(`https://aka.ms/gathersurvey?succeed=${val}`));
    }
}
