#!/usr/bin/env python3
"""
Build-time workspace template generator.

Extracts OpenClaw's default workspace templates from the source tree,
strips YAML frontmatter, appends the customer runtime BASE section to AGENTS.md,
and copies any extra files (e.g., MEMORY.md) from the repo workspace/.

Usage (called from Dockerfile):
  python3 scripts/build-workspace-templates.py \
    --templates-dir /app/docs/reference/templates \
    --base-section /tmp/workspace/agents-base-section.md \
    --extra-dir /tmp/workspace \
    --output-dir /app/workspace
"""

import argparse
import os
import sys


def strip_frontmatter(content: str) -> str:
    """Strip YAML frontmatter from markdown content.

    Matches OpenClaw's own stripFrontMatter() function:
    if the file starts with '---', split on '---' and take
    everything after the second '---', then lstrip.
    """
    if not content.startswith('---'):
        return content
    parts = content.split('---', 2)
    if len(parts) < 3:
        return content
    return parts[2].lstrip()


def main():
    parser = argparse.ArgumentParser(description='Build workspace templates from OpenClaw source')
    parser.add_argument('--templates-dir', required=True, help='Path to OpenClaw templates directory')
    parser.add_argument('--base-section', required=True, help='Path to agents-base-section.md')
    parser.add_argument('--extra-dir', required=True, help='Path to extra workspace files (e.g., MEMORY.md)')
    parser.add_argument('--output-dir', required=True, help='Output directory for generated workspace')
    args = parser.parse_args()

    templates_dir = args.templates_dir
    base_section_path = args.base_section
    extra_dir = args.extra_dir
    output_dir = args.output_dir

    # Verify templates directory exists
    if not os.path.isdir(templates_dir):
        print(f"ERROR: Templates directory not found: {templates_dir}", file=sys.stderr)
        print("This means OpenClaw's source tree structure has changed.", file=sys.stderr)
        print("Expected: docs/reference/templates/ in the OpenClaw repo.", file=sys.stderr)
        sys.exit(1)

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    # Process each template file
    template_files = [f for f in os.listdir(templates_dir) if os.path.isfile(os.path.join(templates_dir, f))]
    if not template_files:
        print(f"WARNING: No template files found in {templates_dir}", file=sys.stderr)

    for filename in sorted(template_files):
        src_path = os.path.join(templates_dir, filename)
        with open(src_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Strip YAML frontmatter
        content = strip_frontmatter(content)

        # For AGENTS.md, append the BASE section.
        if filename == 'AGENTS.md' and not os.path.isfile(base_section_path):
            print(f"ERROR: Base section not found: {base_section_path}", file=sys.stderr)
            print("The built image would miss Sylphx runtime instructions.", file=sys.stderr)
            sys.exit(1)

        if filename == 'AGENTS.md':
            with open(base_section_path, 'r', encoding='utf-8') as f:
                base_section = f.read()
            # Ensure there's a newline before the BASE section
            if not content.endswith('\n'):
                content += '\n'
            content += '\n' + base_section

        dst_path = os.path.join(output_dir, filename)
        with open(dst_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  Generated: {filename} ({len(content)} bytes)")

    # Copy extra files/dirs from repo workspace that OpenClaw doesn't provide
    # (e.g., MEMORY.md, skills/*) — skip agents-base-section.md (build-only)
    if os.path.isdir(extra_dir):
        skip_names = {'agents-base-section.md'}
        for filename in sorted(os.listdir(extra_dir)):
            if filename in skip_names:
                continue
            src_path = os.path.join(extra_dir, filename)
            dst_path = os.path.join(output_dir, filename)
            if os.path.isfile(src_path) and not os.path.exists(dst_path):
                with open(src_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                with open(dst_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"  Extra: {filename} ({len(content)} bytes)")
            elif os.path.isdir(src_path):
                # Recurse for skill packs etc. (skills/memory-consolidate/SKILL.md)
                for root, _dirs, files in os.walk(src_path):
                    rel = os.path.relpath(root, extra_dir)
                    out_root = os.path.join(output_dir, rel)
                    os.makedirs(out_root, exist_ok=True)
                    for fname in sorted(files):
                        s = os.path.join(root, fname)
                        d = os.path.join(out_root, fname)
                        if os.path.exists(d):
                            continue
                        with open(s, 'r', encoding='utf-8') as f:
                            content = f.read()
                        with open(d, 'w', encoding='utf-8') as f:
                            f.write(content)
                        print(f"  Extra: {os.path.join(rel, fname)} ({len(content)} bytes)")

    print(f"Workspace templates generated in {output_dir} ({len(os.listdir(output_dir))} files)")


if __name__ == '__main__':
    main()
