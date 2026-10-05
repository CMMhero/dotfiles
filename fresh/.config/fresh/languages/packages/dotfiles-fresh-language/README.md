# dotfiles-fresh-language

Syntax Highlighting support for Environment (.env) Files

## Features

- Syntax highlighting via Sublime syntax grammar
- Language configuration (comments, indentation)

## Installation

Install via Fresh's package manager:
```
:pkg install dotfiles-fresh-language
```

## Configuration

This language pack provides:

### Grammar
- File extensions: `.env`, `.env.dist`, `.env.local`, `.env.sample`, `.env.example`, `.env.test`, `.env.testing`, `.env.dev`, `.env.development`, `.env.prod`, `.env.production`, `.env.staging`, `.env.default`, `.env.defaults`, `.envrc`, `.flaskenv`
- Syntax highlighting rules in `grammars/syntax.sublime-syntax`

## Development

1. Edit `grammars/syntax.sublime-syntax` for syntax highlighting
2. Update `package.json` with correct file extensions and LSP command
3. Test by copying to `~/.config/fresh/grammars/` and restarting Fresh

**Tip:** Search GitHub for existing `<language> sublime-syntax` files you can adapt.
If using an existing grammar, check its license and include a copy in `grammars/LICENSE`.

## Grammar Attribution

The syntax grammar is derived from [zaynali53/DotENV](https://github.com/zaynali53/DotENV)
by Zayn Ali, licensed under MIT. See `grammars/LICENSE` for details.

## Resources

- [Sublime Text Syntax Documentation](https://www.sublimetext.com/docs/syntax.html)
- [Scope Naming Conventions](https://www.sublimetext.com/docs/scope_naming.html)

## License

MIT
