/********************************************************************************
 * Copyright (c) 2020-2022 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { Action, CenterAction, hasArrayProp, hasStringProp, Point, SelectAction } from '@eclipse-glsp/protocol';
import { inject, injectable } from 'inversify';
import {
    BoundsAware,
    CenterCommand,
    Command,
    CommandExecutionContext,
    CommandReturn,
    findParentByFeature,
    IContextMenuItemProvider,
    isBoundsAware,
    isSelectable,
    KeyListener,
    MenuItem,
    Selectable,
    SIssueMarker,
    SIssueSeverity,
    SModelElement,
    SModelRoot
} from 'sprotty';
import { matchesKeystroke } from 'sprotty/lib/utils/keyboard';
import { TYPES } from '../../base/types';
import { collectIssueMarkers, MarkerPredicates } from '../../utils/marker';
import { isSelectableAndBoundsAware } from '../../utils/smodel-util';
import { SelectCommand, SelectionService } from '../select/selection-service';

export interface NavigateToMarkerAction extends Action {
    kind: typeof NavigateToMarkerAction.KIND;

    direction: MarkerNavigationDirection;
    selectedElementIds?: string[];
    severities: SIssueSeverity[];
}

export type MarkerNavigationDirection = 'next' | 'previous';

export namespace NavigateToMarkerAction {
    export const KIND = 'navigateToMarker';

    export function is(object: any): object is NavigateToMarkerAction {
        return Action.hasKind(object, KIND) && hasStringProp(object, 'direction') && hasArrayProp(object, 'severities');
    }

    export function create(options: {
        direction?: MarkerNavigationDirection;
        selectedElementIds?: string[];
        severities?: SIssueSeverity[];
    }): NavigateToMarkerAction {
        return {
            kind: KIND,
            direction: 'next',
            severities: MarkerNavigator.ALL_SEVERITIES,
            ...options
        };
    }
}
export class SModelElementComparator {
    compare(_one: SModelElement, _other: SModelElement): number {
        return 0;
    }
}

/** Specifies the order of two selectable and bounds-aware elements left-to-right and top-to-bottom. */
@injectable()
export class LeftToRightTopToBottomComparator {
    compare(one: SModelElement, other: SModelElement): number {
        const boundsOne = findParentByFeature(one, isSelectableAndBoundsAware);
        const boundsOther = findParentByFeature(other, isSelectableAndBoundsAware);
        if (boundsOne && boundsOther) {
            if (boundsOne.bounds.y !== boundsOther.bounds.y) {
                return boundsOne.bounds.y - boundsOther.bounds.y;
            }
            if (boundsOne.bounds.x !== boundsOther.bounds.x) {
                return boundsOne.bounds.x - boundsOther.bounds.x;
            }
        }
        return 0;
    }
}

/**
 * Specifies the next/previous marker in a graph model.
 *
 * This navigator uses a `MarkerComparator` to determine the order of markers. It can also return next/previous
 */
@injectable()
export class MarkerNavigator {
    static readonly ALL_SEVERITIES: SIssueSeverity[] = ['error', 'warning', 'info'];

    @inject(SModelElementComparator)
    protected markerComparator: SModelElementComparator;

    next(
        root: SModelRoot,
        current?: SModelElement & BoundsAware,
        predicate: (marker: SIssueMarker) => boolean = MarkerPredicates.ALL
    ): SIssueMarker | undefined {
        const markers = this.getMarkers(root, predicate);
        if (current === undefined) {
            return markers.length > 0 ? markers[0] : undefined;
        }
        return markers[this.getNextIndex(current, markers) % markers.length];
    }

    previous(
        root: SModelRoot,
        current?: SModelElement & BoundsAware,
        predicate: (marker: SIssueMarker) => boolean = MarkerPredicates.ALL
    ): SIssueMarker | undefined {
        const markers = this.getMarkers(root, predicate);
        if (current === undefined) {
            return markers.length > 0 ? markers[0] : undefined;
        }
        return markers[this.getPreviousIndex(current, markers) % markers.length];
    }

    protected getMarkers(root: SModelRoot, predicate: (marker: SIssueMarker) => boolean): SIssueMarker[] {
        const markers = collectIssueMarkers(root);
        return markers.filter(predicate).sort(this.markerComparator.compare);
    }

    protected getNextIndex(current: SModelElement & BoundsAware, markers: SIssueMarker[]): number {
        for (let index = 0; index < markers.length; index++) {
            if (this.markerComparator.compare(markers[index], current) > 0) {
                return index;
            }
        }
        return 0;
    }

    protected getPreviousIndex(current: SModelElement & BoundsAware, markers: SIssueMarker[]): number {
        for (let index = markers.length - 1; index >= 0; index--) {
            if (this.markerComparator.compare(markers[index], current) < 0) {
                return index;
            }
        }
        return markers.length - 1;
    }
}

@injectable()
export class NavigateToMarkerCommand extends Command {
    static KIND = NavigateToMarkerAction.KIND;

    @inject(SModelElementComparator)
    protected markerComparator: SModelElementComparator;

    @inject(MarkerNavigator)
    protected markerNavigator: MarkerNavigator;

    @inject(TYPES.SelectionService)
    protected selectionService: SelectionService;

    protected selectCommand: SelectCommand;
    protected centerCommand: CenterCommand;

    constructor(@inject(TYPES.Action) protected action: NavigateToMarkerAction) {
        super();
    }

    execute(context: CommandExecutionContext): CommandReturn {
        const root = context.root;
        const selected = this.getSelectedElements(root);
        const target = this.getTarget(selected, root);
        if (target === undefined) {
            return root;
        }

        const selectableTarget = findParentByFeature(target, isSelectable);
        if (selectableTarget) {
            const deselect = selected.map(e => e.id).filter(id => id !== selectableTarget.id);
            this.selectCommand = new SelectCommand(
                SelectAction.create({ selectedElementsIDs: [selectableTarget.id], deselectedElementsIDs: deselect }),
                this.selectionService
            );
            this.centerCommand = new CenterCommand(CenterAction.create([selectableTarget.id]));
            this.centerCommand.execute(context);
            return this.selectCommand.execute(context);
        }
        return root;
    }

    protected getSelectedElements(root: SModelRoot): (SModelElement & Selectable)[] {
        let selectedIds = [];
        if (this.action.selectedElementIds !== undefined && this.action.selectedElementIds.length > 0) {
            selectedIds = this.action.selectedElementIds;
        } else {
            return this.selectionService.getSelectedElements();
        }
        return selectedIds.map(id => root.index.getById(id)).filter(element => element !== undefined && isSelectable(element)) as Array<
            SModelElement & Selectable
        >;
    }

    protected getTarget(selected: SModelElement[], root: SModelRoot): SIssueMarker | undefined {
        const selectedBoundsAware = selected.filter(isBoundsAware).sort(this.markerComparator.compare);
        const currentTopmost = selectedBoundsAware.length > 0 ? selectedBoundsAware[0] : undefined;
        if (this.action.direction === 'previous') {
            return this.markerNavigator.previous(root, currentTopmost, marker => this.matchesSeverities(marker));
        } else {
            return this.markerNavigator.next(root, currentTopmost, marker => this.matchesSeverities(marker));
        }
    }

    protected matchesSeverities(marker: SIssueMarker): boolean {
        return marker.issues.find(issue => this.action.severities.includes(issue.severity)) !== undefined;
    }

    undo(context: CommandExecutionContext): CommandReturn {
        if (this.selectCommand) {
            context.root = this.selectCommand.undo(context);
        }
        return this.centerCommand ? this.centerCommand.undo(context) : context.root;
    }

    redo(context: CommandExecutionContext): CommandReturn {
        if (this.selectCommand) {
            context.root = this.selectCommand.redo(context);
        }
        return this.centerCommand ? this.centerCommand.redo(context) : context.root;
    }
}

@injectable()
export class MarkerNavigatorContextMenuItemProvider implements IContextMenuItemProvider {
    @inject(TYPES.SelectionService) protected selectionService: SelectionService;

    getItems(root: Readonly<SModelRoot>, lastMousePosition?: Point): Promise<MenuItem[]> {
        const selectedElementIds = Array.from(this.selectionService.getSelectedElementIDs());
        const hasMarkers = collectIssueMarkers(root).length > 0;
        return Promise.resolve([
            {
                id: 'navigate',
                label: 'Go to',
                group: 'navigate',
                actions: [],
                children: [
                    {
                        id: 'next-marker',
                        label: 'Next marker',
                        group: 'marker',
                        actions: [NavigateToMarkerAction.create({ direction: 'next', selectedElementIds })],
                        isEnabled: () => hasMarkers
                    },
                    {
                        id: 'previous-marker',
                        label: 'Previous marker',
                        group: 'marker',
                        actions: [NavigateToMarkerAction.create({ direction: 'previous', selectedElementIds })],
                        isEnabled: () => hasMarkers
                    }
                ]
            }
        ]);
    }
}

@injectable()
export class MarkerNavigatorKeyListener extends KeyListener {
    override keyDown(_element: SModelElement, event: KeyboardEvent): Action[] {
        if (matchesKeystroke(event, 'Period', 'ctrl')) {
            return [NavigateToMarkerAction.create({ direction: 'next' })];
        } else if (matchesKeystroke(event, 'Comma', 'ctrl')) {
            return [NavigateToMarkerAction.create({ direction: 'previous' })];
        }
        return [];
    }
}
