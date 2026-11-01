import { formatHouseNumber, formatRange } from '../resolver';
import type { Assignment, Place, Resolution } from '../resolver';

/** "★ Престоница: назив, адреса"; the territory is named only when the card spans several. */
export function capitalText(p: Place, withTerritory: boolean): string {
  return `★ Престоница${withTerritory ? ` (територија ${p.territoryId})` : ''}: ${p.name}, ${p.address}`;
}

function peopleText(a: Assignment): string {
  return a.people.deputy ? `${a.people.primary} (заменик: ${a.people.deputy})` : a.people.primary;
}

/** Person(s) and, when `withRange`, the number range the assignment covers. */
function assigneeText(a: Assignment, withRange: boolean): string {
  return `${peopleText(a)}${withRange && a.rule ? ' ' + formatRange(a.rule) : ''}`;
}

/**
 * Plain-text lines of assignments, for Copy and Share. A territory is named once for consecutive assignments
 * of the same territory (the on-screen card does the same); then each one follows on its own indented line.
 */
function assignmentLines(assignments: Assignment[], withRange: boolean): string[] {
  const lines: string[] = [];
  for (let i = 0; i < assignments.length; ) {
    const territory = assignments[i]!.territory;
    let end = i + 1;
    while (end < assignments.length && assignments[end]!.territory.id === territory.id) end++;
    const group = assignments.slice(i, end);
    const heading = `Територија ${territory.id} „${territory.name}“:`;
    if (group.length === 1) lines.push(`${heading} ${assigneeText(group[0]!, withRange)}`);
    else lines.push(heading, ...group.map((a) => `  ${assigneeText(a, withRange)}`));
    i = end;
  }
  return lines;
}

/**
 * Plain-text version of the whole result card. The number is already in the title, so the range is left out
 * when it was entered; it stays where it tells assignments apart: a street split by number (`linear`) and a border
 * number with both assignments.
 */
export function resultText(result: Resolution, title: string, capitals: Place[]): string {
  const lines = [title];
  switch (result.kind) {
    case 'rules':
      lines.push(...assignmentLines(result.assignments, result.border));
      if (result.border) lines.push(`⚠ Број ${formatHouseNumber(result.house)} је граничан: наведена су оба задужења.`);
      break;
    case 'linear':
      lines.push('Улица је подељена по бројевима:', ...assignmentLines(result.segments, true));
      break;
    case 'inherited':
      lines.push(...assignmentLines([result.assignment], false));
      break;
    case 'unassigned':
      lines.push('Улица није додељена.');
      break;
  }
  lines.push(...capitals.map((p) => capitalText(p, capitals.length > 1)));
  return lines.join('\n');
}
