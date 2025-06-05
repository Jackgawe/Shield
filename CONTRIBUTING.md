# Contributing to Shield

Thank you for your interest in contributing to Shield! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How Can I Contribute?

### Reporting Bugs

- Check if the bug has already been reported in the Issues section
- Use the bug report template when creating a new issue
- Include detailed steps to reproduce the bug
- Include screenshots if applicable
- Specify your environment (OS, Discord version, etc.)

### Suggesting Features

- Check if the feature has already been suggested
- Use the feature request template
- Provide a clear description of the feature
- Explain why this feature would be useful
- Include any relevant mockups or examples

### Pull Requests

1. Fork the repository
2. Create a new branch for your feature/fix
3. Make your changes
4. Run tests and ensure they pass
5. Update documentation if necessary
6. Submit a pull request

### Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/Jackgawe/Shield.git
   cd Shield
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Create a new branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

4. Make your changes

5. Run tests:
   ```bash
   pnpm test
   ```

6. Format your code:
   ```bash
   pnpm format
   ```

### Code Style

- Follow the existing code style
- Use TypeScript for all new code
- Write meaningful commit messages
- Keep PRs focused and manageable
- Add tests for new features
- Update documentation as needed

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- feat: A new feature
- fix: A bug fix
- docs: Documentation changes
- style: Code style changes
- refactor: Code refactoring
- test: Adding or fixing tests
- chore: Maintenance tasks

### Pull Request Process

1. Update the README.md with details of changes if needed
2. Update the documentation if needed
3. The PR will be merged once you have the sign-off of at least one maintainer
4. Make sure all tests pass
5. Ensure your code is properly formatted

## Questions?

Feel free to ask questions in our [Discord server](https://discord.gg/M9w4fnxKjx) or open an issue.

Thank you for contributing to Shield! 🚀 