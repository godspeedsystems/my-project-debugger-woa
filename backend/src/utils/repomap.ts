import * as fs from 'fs';
import * as path from 'path';
import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank';
import { TreeContext } from './grep_ast';
// import Sigma from "sigma";
// import { createCanvas } from 'canvas';
// Initialize Tree-sitter and TypeScript parser
const Parser = require('tree-sitter');
const TypeScriptParser = require('tree-sitter-typescript');
// const PythonParser = require('tree-sitter-python');


// console.log('[TOP] Parser module:', TypeScriptParser);
// console.log('[TOP] Parser version:', TypeScriptParser.version);
// Add type definitions for Parser
declare namespace TreeSitter {
  interface Point {
    row: number;
    column: number;
  }
}

// Move interfaces outside namespace
interface Tag {
    rel_fname: string;
    fname: string;
    line: number;
    name: string;
    kind: string;
}

interface CacheEntry {
    mtime: number;
    data: Tag[];
}

interface IO {
    tool_output: (msg: string) => void;
    tool_warning: (msg: string) => void;
    tool_error: (msg: string) => void;
    read_text: (fname: string) => string;
}

// Change to default export and remove redundant export
class RepoMap {
    private readonly root: string;
    private readonly io: IO;
    private readonly verbose: boolean;
    private readonly refresh: 'auto' | 'manual' | 'always' | 'files';
    private readonly TAGS_CACHE: Map<string, CacheEntry>;
    private  max_map_tokens: number;
    private readonly map_mul_no_files: number;
    private readonly max_context_window: number | null;
    private readonly repo_content_prefix: string | null;
    // private readonly main_model: any;
    private readonly tree_cache: Map<string, any>;
    private readonly tree_context_cache: Map<string, any>;
    private readonly map_cache: Map<string, string>;
    private map_processing_time: number;
    private last_map: string | null;

    constructor(options: {
        map_tokens?: number;
        root?: string;
        // main_model?: any;
        io?: IO;
        repo_content_prefix?: string;
        verbose?: boolean;
        max_context_window?: number;
        map_mul_no_files?: number;
        refresh?: 'auto' | 'manual' | 'always' | 'files';
    }) {
        // Remove unused properties
        this.io = options.io || {
            tool_output: console.log,
            tool_warning: console.warn,
            tool_error: console.error,
            read_text: (fname: string) => fs.readFileSync(fname, 'utf-8'),
        };
        this.verbose = options.verbose || false;
        this.refresh = options.refresh || 'auto';
        this.root = path.resolve(options.root || process.cwd());

        this.TAGS_CACHE = new Map();
        this.max_map_tokens = options.map_tokens || 1024;
        this.map_mul_no_files = options.map_mul_no_files || 8;
        this.max_context_window = options.max_context_window || null;

        this.repo_content_prefix = options.repo_content_prefix || null;
        // this.main_model = options.main_model;

        this.tree_cache = new Map();
        this.tree_context_cache = new Map();
        this.map_cache = new Map();
        this.map_processing_time = 0;
        this.last_map = null;

        if (this.verbose) {
            this.io.tool_output(
                `RepoMap initialized with map_mul_no_files: ${this.map_mul_no_files}`
            );
        }


    }

    private get_mtime(fname: string): number | undefined {
        try {
            return fs.statSync(fname).mtimeMs;
        } catch (error: any) { // Use any type for now
            if (error?.code === 'ENOENT') {
                this.io.tool_warning(`File not found error: ${fname}`);
            }
            return undefined;
        }
    }

    private get_rel_fname(fname: string): string {
        try {
            return path.relative(this.root, fname);
        } catch (error) {
            return fname;
        }
    }

    public async get_repo_map(
        chat_files: string[],
        other_files: string[],
        mentioned_fnames: Set<string> = new Set(),
        mentioned_idents: Set<string> = new Set(),
        force_refresh: boolean = false
    ): Promise<string | undefined> {
        if (this.max_map_tokens <= 0 || !other_files) return;
        // console.log(chat_files);

        let max_map_tokens = this.max_map_tokens;
        const padding = 4096;

        if (max_map_tokens && this.max_context_window) {
            const target = Math.min(
                Math.floor(max_map_tokens * this.map_mul_no_files),
                this.max_context_window - padding
            );
            if (!chat_files.length && this.max_context_window && target > 0) {
                max_map_tokens = target;
            }
        }

        try {
            console.log("Generating ranked tags map...");
            const files_listing = await this.get_ranked_tags_map(
                chat_files,
                other_files,
                max_map_tokens,
                mentioned_fnames,
                mentioned_idents,
                force_refresh
            );

            // console.log("Ranked tags map result:", files_listing);

            if (!files_listing) {
                // console.log("No files listing generated");
                return;
            }

            if (this.verbose) {
                const num_tokens = this.token_count(await files_listing);
                this.io.tool_output(`Repo-map: ${(num_tokens / 1024).toFixed(1)} k-tokens`);
            }

            const other = chat_files.length ? "other " : "";
            let repo_content = "";

            if (this.repo_content_prefix) {
                repo_content = this.repo_content_prefix.replace("{other}", other);
            }

            return repo_content + files_listing;

        } catch (error) {
            if (error instanceof RangeError) {
                this.io.tool_error("Disabling repo map, git repo too large?");
                this.max_map_tokens = 0;
            }
            return;
        }
    }

    private async getTags(fname: string, rel_fname: string): Promise<Tag[]> {
        const file_mtime = this.get_mtime(fname);
        if (file_mtime === undefined) {
            return [];
        }

        const cache_key = fname;
        const cached = this.TAGS_CACHE.get(cache_key);

        if (cached && cached.mtime === file_mtime) {
            return cached.data;
        }

        const data = await this.getTagsRaw(fname, rel_fname);
        this.TAGS_CACHE.set(cache_key, { mtime: file_mtime, data });
        return data;
    }


    private async getTagsRaw(fname: string, rel_fname: string): Promise<Tag[]> {
        try {
            const parser = new Parser();

            // Debug: Check if TypeScriptParser is valid
            if (!TypeScriptParser) {
                this.io.tool_error(`TypeScriptParser is not defined`);
                return [];
            }

            // Set the language explicitly
            parser.setLanguage(TypeScriptParser.typescript); // Use TypeScript parser
            // this.io.tool_output('[DEBUG] Language set to TypeScript');

            // Debug: Check if the language is loaded correctly
            const lang = parser.getLanguage();
            if (!lang) {
                this.io.tool_error(`Language not loaded for file: ${fname}`);
                return [];
            }
            // this.io.tool_output(`[DEBUG] Loaded language: ${lang.name}, version: ${lang.version}`);

            // Load and check SCM query file
            const scmPath = getSCMFilePath('typescript'); // Hardcoded for TypeScript
            // this.io.tool_output(`Loading SCM file from: ${scmPath}`);

            if (!fs.existsSync(scmPath)) {
                this.io.tool_warning(`No query file found for TypeScript at ${scmPath}`);
                return [];
            }

            const scmQuery = fs.readFileSync(scmPath, 'utf8');
            // this.io.tool_output(`SCM Query: ${scmQuery}`);

            const code = this.io.read_text(fname);
            if (!code) {
                this.io.tool_warning(`File is empty: ${fname}`);
                return [];
            }

            const tree = parser.parse(code);
            // this.io.tool_output(`Parsed tree for file: ${fname}`);

            const query = new Parser.Query(TypeScriptParser.typescript, scmQuery); // Use TypeScript parser
            // this.io.tool_output(`Query created successfully`);

            const captures = query.captures(tree.rootNode); // Execute the query
            // this.io.tool_output(`Found ${captures.length} captures in file: ${fname}`);

            const tags: Tag[] = [];
            const saw = new Set<string>();

            for (const { node, name } of captures) {
                let kind: string;
                if (name.startsWith('name.definition.')) {
                    kind = 'def';
                } else if (name.startsWith('name.reference.')) {
                    kind = 'ref';
                } else {
                    continue;
                }

                saw.add(kind);
                tags.push({
                    rel_fname,
                    fname,
                    name: node.text,
                    kind,
                    line: node.startPosition.row + 1, // Convert to 1-based line number
                });

                this.io.tool_output(`Capture: name=${name}, text=${node.text}, kind=${kind}, line=${node.startPosition.row + 1}`);
            }

            // Skip if we only have refs without defs
            if (saw.has('ref') && !saw.has('def')) {
                // this.io.tool_warning(`Skipping file ${fname}: Only references found, no definitions`);
                return [];
            }

            return tags;

        } catch (err) {
            // this.io.tool_error(`Error processing ${fname}: ${err}`);
            return [];
        }
    }
    private async getRankedTags(
        chat_fnames: string[],
        other_fnames: string[],
        _mentionedFiles: Set<string>,
        mentioned_idents: Set<string>
    ): Promise<Tag[]> {
        // Log input files
        // console.log(`Chat files: ${chat_fnames.join(', ')}`);
        // console.log(`Other files: ${other_fnames.join(', ')}`);

        // Combine all files into a single set
        const fnames = new Set([...chat_fnames, ...other_fnames]);

        // Handle single-file case
        if (fnames.size === 1) {
            console.warn('Only one file found. Skipping graph building and returning all tags.');

            // Get the single file from the set
            const singleFile = fnames.values().next().value;

            // Ensure singleFile is defined
            if (!singleFile) {
                console.error('No files found in the input.');
                return [];
            }

            // Get relative file name and tags
            const rel_fname = this.get_rel_fname(singleFile);
            const tags = await this.getTags(singleFile, rel_fname);

            // Rank tags within the single file
            return tags;
        }

        // Proceed with graph building for multiple files
        const graph = new Graph({ type: 'directed' });
        const defines = new Map<string, Set<string>>();
        const references = new Map<string, string[]>();
        const definitions = new Map<string, Set<Tag>>();

        // Process all files to build the graph
        for (const fname of fnames) {
            const rel_fname = this.get_rel_fname(fname);
            const tags = await this.getTags(fname, rel_fname);

            // console.log(`Tags for file ${fname}:`, tags);

            for (const tag of tags) {
                if (tag.kind === 'def') {
                    if (!defines.has(tag.name)) {
                        defines.set(tag.name, new Set());
                    }
                    defines.get(tag.name)!.add(rel_fname);

                    const key = `${rel_fname}:${tag.name}`;
                    if (!definitions.has(key)) {
                        definitions.set(key, new Set());
                    }
                    definitions.get(key)!.add(tag);
                } else if (tag.kind === 'ref') {
                    if (!references.has(tag.name)) {
                        references.set(tag.name, []);
                    }
                    references.get(tag.name)!.push(rel_fname);
                }
            }
        }

        // Build the graph
        for (const [ident, defs] of defines.entries()) {
            const refs = references.get(ident) || [];
            const weight = mentioned_idents.has(ident) ? 2 :
                           ident.startsWith('_') ? 0.5 : 1;

            for (const definer of defs) {
                for (const referencer of refs) {
                    // Skip invalid nodes
                    if (!definer || !referencer) {
                        console.warn(`Skipping invalid edge: definer=${definer}, referencer=${referencer}`);
                        continue;
                    }

                    // Calculate edge weight
                    const edgeWeight = weight * Math.sqrt(refs.length);

                    // Add nodes if they don't exist
                    if (!graph.hasNode(definer)) graph.addNode(definer);
                    if (!graph.hasNode(referencer)) graph.addNode(referencer);

                    // Add edge if it doesn't exist
                    if (!graph.hasDirectedEdge(referencer, definer)) {
                        graph.addDirectedEdge(referencer, definer, {
                            weight: edgeWeight,
                            ident
                        });
                        // console.log(`Added edge: ${referencer} -> ${definer}, weight=${edgeWeight}, ident=${ident}`);
                    }
                }
            }




            


            
        }

        // Log graph structure
        // console.log(`Graph nodes: ${graph.nodes().join(', ')}`);
        // console.log(`Graph edges: ${graph.edges().join(', ')}`);

        // Fix unused parameter in pagerank
        const ranked = pagerank(graph, {
            alpha: 0.85,
            getEdgeWeight: (_edge, attrs) => attrs.weight || 1
        });

        // Log ranked results
        // console.log(`Ranked results: ${JSON.stringify(ranked)}`);

        // Sort and process results
        const rankedTags: Tag[] = [];
        const rankedEntries = Object.entries(ranked)
            .sort(([, a], [, b]) => b - a);

        for (const [fname] of rankedEntries) {
            if (chat_fnames.includes(fname)) continue;

            for (const [key, tags] of definitions) {
                if (key.startsWith(`${fname}:`)) {
                    rankedTags.push(...Array.from(tags));
                }
            }
        }
        // const width = 800; // Desired width of the image
        // const height = 600; // Desired height of the image
        // const canvas = createCanvas(width, height);
        // const context = canvas.getContext("2d");
        
        // // Render the graph onto the canvas
        // const renderer = new Sigma(graph, canvas as unknown as HTMLElement, {
        //   renderEdgeLabels: true,
        // });
        
        // // Set background color
        // context.fillStyle = "#ffffff"; // White background
        // context.fillRect(0, 0, width, height);
        
        // // Render the graph
        // renderer.refresh();
        
        // // Save the canvas as an image file
        // const outputFilePath = "./graph.png"; // Change to .jpg if needed
        // const stream = canvas.createPNGStream(); // Use createJPEGStream() for JPG
        // const out = fs.createWriteStream(outputFilePath);
        // stream.pipe(out);

        // console.log("Ranked tags:", rankedTags);
        return rankedTags;
    }

    private token_count(text: string): number {
        const len_text = text.length;
        // console.log(`Length of text: ${len_text}`); // Debugging
        if (len_text < 200) {
            return len_text/4;
        }

        const lines = text.split('\n');
        // console.log(`Number of lines: ${lines.length}`); // Debugging
        const num_lines = lines.length;
        // console.log(`Number of lines: ${num_lines}`); // Debugging
        const step = Math.max(1, Math.floor(num_lines / 100));
        // console.log(`Step value: ${step}`); // Debugging
        const sample_lines = lines.filter((_, i) => i % step === 0);
        // console.log(`Sample lines: ${sample_lines}`); // Debugging
        const sample_text = sample_lines.join('\n');
        // console.log(`Sample text: ${sample_text.length}`); // Debugging

        const sample_tokens = sample_text.length/4;
        // console.log(sample_tokens); // Debugging
        // console.log(`Sample tokens: ${sample_tokens}`); // Debugging


        return Math.floor((sample_tokens / sample_text.length) * len_text);
    }

    private get_ranked_tags_map(
        chat_fnames: string[],
        other_fnames: string[] = [],
        max_map_tokens?: number,
        mentioned_fnames: Set<string> = new Set(),
        mentioned_idents: Set<string> = new Set(),
        force_refresh: boolean = false
    ): Promise<string> {
        // Create cache key
        const cache_key = JSON.stringify([
            chat_fnames.sort(),
            other_fnames.sort(),
            max_map_tokens,
            this.refresh === 'auto' ? Array.from(mentioned_fnames).sort() : null,
            this.refresh === 'auto' ? Array.from(mentioned_idents).sort() : null,
        ]);

        let use_cache = false;
        if (!force_refresh) {
            if (this.refresh === 'manual' && this.last_map) {
                return Promise.resolve(this.last_map);
            }

            if (this.refresh === 'always') {
                use_cache = false;
            } else if (this.refresh === 'files') {
                use_cache = true;
            } else if (this.refresh === 'auto') {
                use_cache = this.map_processing_time > 1.0;
            }

            if (use_cache && this.map_cache.has(cache_key)) {
                return Promise.resolve(this.map_cache.get(cache_key) || '');
            }
        }

        return this.get_ranked_tags_map_uncached(
            chat_fnames,
            other_fnames,
            max_map_tokens,
            mentioned_fnames,
            mentioned_idents
        );
    }

    private async get_ranked_tags_map_uncached(
        chat_fnames: string[],
        other_fnames: string[] = [],
        max_map_tokens?: number,
        mentioned_fnames: Set<string> = new Set(),
        mentioned_idents: Set<string> = new Set()
    ): Promise<string> {
        // Ensure max_map_tokens is a valid number
        if (max_map_tokens === undefined || max_map_tokens === null || max_map_tokens <= 0) {
            max_map_tokens = this.max_map_tokens || 1024; // Default to 1024 if not set
        }

        // console.log("Getting ranked tags...");
        const ranked_tags = await this.getRankedTags(
            chat_fnames,
            other_fnames,
            mentioned_fnames,
            mentioned_idents
        );

        // console.log(`Found ${ranked_tags.length} ranked tags`);

        const other_rel_fnames = [...new Set(
            other_fnames.map(fname => this.get_rel_fname(fname))
        )].sort();

        const special_fnames = filterImportantFiles(other_rel_fnames);
        const ranked_tags_fnames = new Set(ranked_tags.map(tag => tag.rel_fname));
        const additional_special = special_fnames
            .filter(fn => !ranked_tags_fnames.has(fn))
            .map(fn => ({ rel_fname: fn } as Tag));

        ranked_tags.unshift(...additional_special);

        // console.log("Ranked tags after adding special files:", ranked_tags);

        const num_tags = ranked_tags.length;
        let lower_bound = 0;
        let upper_bound = num_tags;
        let best_tree: string | undefined;
        let best_tree_tokens = 0;

        const chat_rel_fnames = new Set(
            chat_fnames.map(fname => this.get_rel_fname(fname))
        );

        this.tree_cache.clear();

        // Ensure max_map_tokens is a valid number

        // console.log("hello 78");
        let middle = Math.min(Math.floor(max_map_tokens / 25), num_tags);
        // console.log(`Initial middle value: ${middle}`); // Debugging

        while (lower_bound <= upper_bound) {
            // console.log(`Current bounds: lower_bound=${lower_bound}, upper_bound=${upper_bound}, middle=${middle}`); // Debugging

            // Generate the tree
            const tree = this.to_tree(
                ranked_tags.slice(0, middle),
                chat_rel_fnames
            );

            
            // console.log(`Tree generated for middle=${middle}`); // Debugging

            // Count the tokens in the tree
            const num_tokens = this.token_count(tree);

            // console.log(`Number of tokens: ${num_tokens}`); // Debugging

            // Calculate the percentage error
            const pct_err = Math.abs(num_tokens - max_map_tokens) / max_map_tokens;
            // console.log(`Percentage error: ${pct_err}`); // Debugging

            const ok_err = 0.15;
            // console.log(`Acceptable error threshold: ${ok_err}`); // Debugging

            // Check if the current tree is the best fit
            if ((num_tokens <= max_map_tokens && num_tokens > best_tree_tokens) || pct_err < ok_err) {
                best_tree = tree;
                best_tree_tokens = num_tokens;
                // console.log(`New best tree found: tokens=${best_tree_tokens}`); // Debugging

                if (pct_err < ok_err) {
                    // console.log(`Percentage error within acceptable threshold. Breaking loop.`); // Debugging
                    break;
                }
            }

            // Adjust the bounds based on the number of tokens
            if (num_tokens < max_map_tokens) {
                lower_bound = middle + 1;
                // console.log(`Increasing lower_bound to ${lower_bound}`); // Debugging
            } else {
                upper_bound = middle - 1;
                // console.log(`Decreasing upper_bound to ${upper_bound}`); // Debugging
            }

            // Recalculate the middle value
            middle = Math.floor((lower_bound + upper_bound) / 2);
            // console.log(`New middle value: ${middle}`); // Debugging
        }

        // console.log("Best tree generated:", best_tree);
        return best_tree || '';
    }

    private to_tree(tags: Tag[], chat_rel_fnames: Set<string>): string {
        if (!tags.length) {
            // console.log("No tags provided to generate tree");
            return '';
        }

        // console.log("we are in totree");

        let cur_fname: string | null = null;
        let cur_abs_fname: string | null = null;
        let lois: number[] | null = null;
        let output = '';

        // Add dummy tag safely
        const dummy_tag = {
            rel_fname: null,
            fname: '',
            line: 0,
            name: '',
            kind: ''
        } as unknown as Tag;

        // Check if there's only one file
        const isSingleFile = new Set(tags.map(tag => tag.rel_fname)).size === 1;
        // console.log(`Processing ${isSingleFile ? 'single file' : 'multiple files'}`); // Debugging

        // Add dummy_tag only if there are multiple files
        const tagsToProcess = isSingleFile ? tags : [...tags, dummy_tag];

        for (const tag of tagsToProcess) {
            // console.log(`Processing tag:`, tag); // Debugging

            // Skip tags from chat files
            if (chat_rel_fnames.has(tag.rel_fname)) {
                // console.log(`Skipping tag from chat file: ${tag.rel_fname}`); // Debugging
                continue;
            }

            // Check if the current file has changed
            if (tag.rel_fname !== cur_fname) {
                // console.log(`File changed: new file=${tag.rel_fname}, current file=${cur_fname}`); // Debugging

                // Render the tree for the previous file
                if (lois !== null && cur_fname && cur_abs_fname) {
                    // console.log(`Rendering tree for file: ${cur_fname}`); // Debugging
                    output += '\n' + cur_fname + ':\n';
                    output += this.render_tree(cur_abs_fname, cur_fname, lois);
                    lois = null;
                } else if (cur_fname) {
                    // console.log(`Adding file header: ${cur_fname}`); // Debugging
                    output += '\n' + cur_fname + '\n';
                }

                // Initialize for the new file
                if (tag.rel_fname && 'line' in tag) {
                    // console.log(`Initializing for new file: ${tag.rel_fname}`); // Debugging
                    lois = [];
                    cur_abs_fname = tag.fname;
                }
                cur_fname = tag.rel_fname;
            }

            // Add the line number to the list of lines of interest
            if (lois !== null && 'line' in tag) {
                // console.log(`Adding line to lois: ${tag.line}`); // Debugging
                lois.push(tag.line);
            }
        }

        // Render the tree for the single file (if applicable)
        if (isSingleFile && cur_fname && cur_abs_fname && lois !== null) {
            // console.log(`Rendering tree for single file: ${cur_fname}`); // Debugging
            // console.log(`Current lois:`, lois);
            output += '\n' + cur_fname + ':\n';
            // console.log(`Current lois:`, lois); // Debugging
            output += this.render_tree(cur_abs_fname, cur_fname, lois);
        }

        // Truncate long lines
        const result = output.split('\n')
            .map(line => line.slice(0, 100))
            .join('\n') + '\n';

        // console.log(`Final tree output:`, result); // Debugging

        return result;
    }

    private render_tree(abs_fname: string, rel_fname: string, lois: number[]): string {
        const mtime = this.get_mtime(abs_fname);
        const key = JSON.stringify([rel_fname, lois.sort(), mtime]);

        if (this.tree_cache.has(key)) {
            // console.log("Using cached tree for:", rel_fname);
            return this.tree_cache.get(key);
        }

        if (!this.tree_context_cache.has(rel_fname) ||
            this.tree_context_cache.get(rel_fname).mtime !== mtime) {

            let code = this.io.read_text(abs_fname) || '';
            if (!code.endsWith('\n')) code += '\n';
            // console.log("Read text for file:", rel_fname);

            const context = new TreeContext(
                rel_fname,
                code,
                {
                    color: false,
                    lineNumber: false,
                    childContext: false,
                    lastLine: false,
                    margin: 0,
                    markLois: false,
                    loiPad: 0,
                    showTopOfFileParentScope: false
                }
            );
            // console.log("Created new tree context for:", rel_fname);
            this.tree_context_cache.set(rel_fname, { context, mtime });
        }

        const { context } = this.tree_context_cache.get(rel_fname);
        context.lines_of_interest = new Set();
        context.add_lines_of_interest(lois);
        context.add_context();
        const res = context.format();
        this.tree_cache.set(key, res);

        // console.log("Rendered tree for:", rel_fname);
        return res;
    }
}

// Helper functions
function filterImportantFiles(fnames: string[]): string[] {
    return fnames.filter(fname => {
        const lower = fname.toLowerCase();
        return lower.includes('readme') ||
               lower.includes('tsconfig.json') ||
               lower.includes('package.json');
    });
}

function getSCMFilePath(lang: string): string {
    return path.join(__dirname, '..', '..', 'queries', `tree-sitter-${lang}-tags.scm`);
}

// Export types and default export
export type { Tag, CacheEntry, IO };
export default RepoMap;