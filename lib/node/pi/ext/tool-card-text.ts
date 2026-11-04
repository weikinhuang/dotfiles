/** Read-only, width-aware text sections for expanded tool cards. */
import { Container, Text, truncateToWidth } from '@earendil-works/pi-tui';

export class ToolCardText extends Text {
  constructor(
    text: string,
    private readonly maxLines = 8,
    private readonly tail = false,
  ) {
    super(text, 0, 0);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const limit = Math.max(1, Math.floor(this.maxLines));
    if (lines.length <= limit) return lines;
    const notice = truncateToWidth(`… (${lines.length - limit} more lines)`, width);
    return this.tail ? [notice, ...lines.slice(-limit)] : [...lines.slice(0, limit), notice];
  }
}

export function toolCardSection(title: string, text: string, maxLines = 8, tail = false): Container {
  const section = new Container();
  section.addChild(new Text(title, 0, 0));
  section.addChild(new ToolCardText(text, maxLines, tail));
  return section;
}
