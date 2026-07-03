import * as vscode from "vscode";
import { Snapshot, SnapshotEngine } from "../snapshot/engine";
import { relativeTime, TRIGGER_BADGE } from "./restoreUi";

interface DayGroup {
  kind: "day";
  label: string;
  snapshots: Snapshot[];
}

export interface SnapshotNode {
  kind: "snapshot";
  snapshot: Snapshot;
}

type Node = DayGroup | SnapshotNode;

function dayLabel(timestamp: number, now: Date): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(timestamp);
  day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Sidebar timeline: snapshots grouped by day, newest first. */
export class TimelineProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly engine: SnapshotEngine) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element) {
      return element.kind === "day"
        ? element.snapshots.map((snapshot) => ({ kind: "snapshot", snapshot }))
        : [];
    }
    const snapshots = await this.engine.list();
    const now = new Date();
    const groups: DayGroup[] = [];
    for (const snapshot of snapshots) {
      const label = dayLabel(snapshot.timestamp, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) {
        last.snapshots.push(snapshot);
      } else {
        groups.push({ kind: "day", label, snapshots: [snapshot] });
      }
    }
    return groups;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === "day") {
      const item = new vscode.TreeItem(
        element.label,
        element.label === "Today"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${element.snapshots.length} snapshot(s)`;
      return item;
    }

    const { snapshot } = element;
    const time = new Date(snapshot.timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const item = new vscode.TreeItem(`${TRIGGER_BADGE[snapshot.trigger]} — ${time}`);
    item.id = snapshot.ref;
    item.description = relativeTime(snapshot.timestamp);
    item.tooltip = `${new Date(snapshot.timestamp).toLocaleString()}\n${snapshot.hash.slice(0, 12)}\nClick to restore (with preview & confirmation)`;
    item.contextValue = "lkgSnapshot";
    item.command = {
      command: "lastKnownGood.restoreSnapshot",
      title: "Restore this snapshot",
      arguments: [element],
    };
    return item;
  }
}
