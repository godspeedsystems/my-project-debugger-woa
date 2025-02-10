const Parser = require('tree-sitter');
const TypeScriptParser = require('tree-sitter-typescript');

// Add type definitions for Parser
declare namespace TreeSitter {
  interface Point {
    row: number;
    column: number;
  }

  interface SyntaxNode {
    type: string;
    text: string;
    startPosition: Point;
    endPosition: Point;
    children: SyntaxNode[];
  }

  interface Tree {
    rootNode: SyntaxNode;
  }
}

interface TreeContextOptions {
    color?: boolean;
    verbose?: boolean;
    lineNumber?: boolean;
    parentContext?: boolean;
    childContext?: boolean;
    lastLine?: boolean;
    margin?: number;
    markLois?: boolean;
    headerMax?: number;
    showTopOfFileParentScope?: boolean;
    loiPad?: number;
}

export class TreeContext {
    private lines: string[];
    private numLines: number;
    private outputLines: Map<number, string>;
    private scopes: Set<number>[];
    private header: [number, number][];
    private nodes: TreeSitter.SyntaxNode[][];
    private showLines: Set<number>;
    private doneParentScopes: Set<number>;
    
    public lines_of_interest: Set<number>;

    private options: Required<TreeContextOptions>;

    constructor(
        _filename: string,  // Add underscore to indicate unused parameter
        code: string,
        options: TreeContextOptions = {}
    ) {
        this.options = {
            color: options.color ?? false,
            verbose: options.verbose ?? false,
            lineNumber: options.lineNumber ?? false,
            parentContext: options.parentContext ?? true,
            childContext: options.childContext ?? true,
            lastLine: options.lastLine ?? true,
            margin: options.margin ?? 3,
            markLois: options.markLois ?? true,
            headerMax: options.headerMax ?? 10,
            showTopOfFileParentScope: options.showTopOfFileParentScope ?? true,
            loiPad: options.loiPad ?? 1
        };

        this.lines = code.split('\n');
        this.numLines = this.lines.length + 1;
        this.outputLines = new Map();
        this.scopes = Array(this.numLines).fill(null).map(() => new Set());
        this.header = Array(this.numLines).fill([0, 0]);
        this.nodes = Array(this.numLines).fill(null).map(() => []);
        this.showLines = new Set();
        this.lines_of_interest = new Set();
        this.doneParentScopes = new Set();

        console.log("Parsing code...");

        const parser = new Parser();  // Remove 'new' keyword
        parser.setLanguage(TypeScriptParser.typescript); // Use TypeScript parser directly
        const tree = parser.parse(code);
        // console.log(tree);

        this.walkTree(tree.rootNode);

        if (this.options.verbose) {
            const scopeWidth = Math.max(...Array.from(
                { length: this.numLines - 1 },
                (_, i) => this.scopes[i].size.toString().length
            ));
            
            for (let i = 0; i < this.numLines - 1; i++) {
                const scopes = Array.from(this.scopes[i]).sort().toString();
                console.log(scopes.padEnd(scopeWidth), i, this.lines[i]);
            }
        }

        this.processHeaders();
    }

    private processHeaders() {
        for (let i = 0; i < this.numLines; i++) {
            const headerData = this.header[i];
            if (headerData.length > 1) {
                // Safely extract values with type checking
                const size = Number(headerData[0]) || 0;
                const headStart = Number(headerData[1]) || i;
                const headEnd = size > this.options.headerMax ? 
                    headStart + this.options.headerMax : 
                    headStart + size;
                this.header[i] = [headStart, headEnd];
            } else {
                this.header[i] = [i, i + 1];
            }
        }
    }

    private walkTree(node: TreeSitter.SyntaxNode, depth: number = 0): [number, number] {
        const start = node.startPosition;
        const end = node.endPosition;

        const startLine = start.row;
        const endLine = end.row;
        const size = endLine - startLine;

        this.nodes[startLine].push(node);

        if (this.options.verbose && node.type !== '') {  // Replace isNamed() check
            console.log(
                "   ".repeat(depth),
                node.type,
                `${startLine}-${endLine}=${size + 1}`,
                node.text.split('\n')[0],
                this.lines[startLine]
            );
        }

        if (size) {
            this.header[startLine].push(size, startLine, endLine);
        }

        for (let i = startLine; i <= endLine; i++) {
            this.scopes[i].add(startLine);
        }

        for (const child of node.children) {
            this.walkTree(child, depth + 1);
        }

        return [startLine, endLine];
    }

    public grep(pattern: string, ignoreCase: boolean = false): Set<number> {
        const found = new Set<number>();
        const flags = ignoreCase ? 'i' : '';
        const regex = new RegExp(pattern, flags);

        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (regex.test(line)) {
                if (this.options.color) {
                    const highlighted = line.replace(regex, match => 
                        `\x1b[1;31m${match}\x1b[0m`
                    );
                    this.outputLines.set(i, highlighted);
                }
                found.add(i);
            }
        }
        return found;
    }



    public add_lines_of_interest(lineNums: number[]): void {
        lineNums.forEach(line => this.lines_of_interest.add(line));
    }

    public add_context(): void {
        if (!this.lines_of_interest.size) return;

        this.showLines = new Set(this.lines_of_interest);

        // Add padding around lines of interest
        if (this.options.loiPad) {
            for (const line of Array.from(this.showLines)) {
                for (let i = line - this.options.loiPad; i <= line + this.options.loiPad; i++) {
                    if (i >= 0 && i < this.numLines) {
                        this.showLines.add(i);
                    }
                }
            }
        }

        // Add context based on options
        if (this.options.lastLine) {
            const bottomLine = this.numLines - 2;
            this.showLines.add(bottomLine);
            this.addParentScopes(bottomLine);
        }

        if (this.options.parentContext) {
            for (const i of this.lines_of_interest) {
                this.addParentScopes(i);
            }
        }

        if (this.options.childContext) {
            for (const i of this.lines_of_interest) {
                this.addChildContext(i);
            }
        }

        // Add top margin
        if (this.options.margin) {
            for (let i = 0; i < this.options.margin; i++) {
                this.showLines.add(i);
            }
        }

        this.closeSmallGaps();
    }

    private addChildContext(line: number): void {
        if (!this.nodes[line].length) return;

        const lastLine = Math.max(...this.nodes[line].map(n => n.endPosition.row));
        const size = lastLine - line;
        
        if (size < 5) {
            for (let i = line; i <= lastLine; i++) {
                this.showLines.add(i);
            }
            return;
        }

        const children = this.findAllChildren(this.nodes[line])
            .sort((a, b) => 
                (b.endPosition.row - b.startPosition.row) - 
                (a.endPosition.row - a.startPosition.row)
            );

        const currentlyShowing = this.showLines.size;
        const maxToShow = Math.max(
            Math.min(size * 0.10, 25),
            5
        );

        for (const child of children) {
            if (this.showLines.size > currentlyShowing + maxToShow) {
                break;
            }
            const childStartLine = child.startPosition.row;
            this.addParentScopes(childStartLine);
        }
    }

    private findAllChildren(nodes: TreeSitter.SyntaxNode[]): TreeSitter.SyntaxNode[] {
        const children: TreeSitter.SyntaxNode[] = [];
        for (const node of nodes) {
            children.push(node);
            children.push(...this.findAllChildren(node.children));
        }
        return children;
    }

    private getLastLineOfScope(line: number): number {
        return Math.max(...this.nodes[line].map(node => node.endPosition.row));
    }

    private closeSmallGaps(): void {
        const closedShow = new Set(this.showLines);
        const sortedShow = Array.from(this.showLines).sort((a, b) => a - b);

        // Fill single-line gaps
        for (let i = 0; i < sortedShow.length - 1; i++) {
            if (sortedShow[i + 1] - sortedShow[i] === 2) {
                closedShow.add(sortedShow[i] + 1);
            }
        }

        // Add adjacent blank lines
        for (let i = 0; i < this.lines.length; i++) {
            if (!closedShow.has(i)) continue;
            if (this.lines[i].trim() && 
                i < this.lines.length - 2 && 
                !this.lines[i + 1].trim()) {
                closedShow.add(i + 1);
            }
        }

        this.showLines = closedShow;
    }

    private addParentScopes(i: number): void {
        if (this.doneParentScopes.has(i)) return;
        this.doneParentScopes.add(i);

        if (i >= this.scopes.length) return;

        for (const lineNum of this.scopes[i]) {
            const [headStart, headEnd] = this.header[lineNum];
            if (headStart > 0 || this.options.showTopOfFileParentScope) {
                for (let j = headStart; j < headEnd; j++) {
                    this.showLines.add(j);
                }
            }

            if (this.options.lastLine) {
                const lastLine = this.getLastLineOfScope(lineNum);
                this.addParentScopes(lastLine);
            }
        }
    }

    public format(): string {
        if (!this.showLines.size) return "";

        let output = "";
        if (this.options.color) {
            output += "\x1b[0m\n";  // reset color
        }

        let dots = !this.showLines.has(0);
        for (let i = 0; i < this.lines.length; i++) {
            if (!this.showLines.has(i)) {
                if (dots) {
                    output += this.options.lineNumber ? "...⋮...\n" : "⋮...\n";
                    dots = false;
                }
                continue;
            }

            let spacer = this.lines_of_interest.has(i) && this.options.markLois
                ? this.options.color ? "\x1b[31m█\x1b[0m" : "█"
                : "│";

            let lineOutput = `${spacer}${this.outputLines.get(i) || this.lines[i]}`;
            if (this.options.lineNumber) {
                lineOutput = `${(i + 1).toString().padStart(3)} ${lineOutput}`;
            }
            output += lineOutput + "\n";

            dots = true;
        }

        return output;
    }
}
