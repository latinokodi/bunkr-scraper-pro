# Project Git & GitHub Workflow Best Practices

This document outlines the standard workflow for maintaining a clean, versioned, and recoverable history for this project.

## 1. The Power of Atomic Commits
An **atomic commit** encapsulates exactly one logical change. Avoid "mega-commits" that mix fixes, features, and styling.
- **Why**: If a feature breaks the app, you can `git revert` only that specific feature without losing your other work.
- **Template**: Use [Conventional Commits](https://www.conventionalcommits.org/).
  - `feat: ...` for new features
  - `fix: ...` for bug fixes
  - `refactor: ...` for code cleanup

## 2. Feature Branching (GitHub Flow)
**Never work directly on the `main` branch.**
1. `git checkout -b feature/your-feature-name`
2. Make your atomic commits.
3. `git push origin feature/your-feature-name`
4. Open a **Pull Request (PR)** on GitHub to merge into `main`.

## 3. Pushing & Pulling
- **Push Often**: GitHub is your remote backup. Push your feature branch even if it's incomplete.
- **Pull Before Starting**: Always `git pull origin main` into your feature branch to ensure you are working on the latest code.

## 4. Versioning with Tags
When you reach a stable milestone (e.g., v1.0.0), create a permanent "bookmark":
```bash
git tag -a v1.0.0 -m "First stable release"
git push origin v1.0.0
```

## 5. Recovery Cheat Sheet ("Going Back")

### Peek at the past (Read-only)
```bash
git checkout <commit-hash>
```

### Undo a specific change (Safe)
```bash
git revert <commit-hash>
```
*This creates a new commit that undoes the work of the old one, keeping the timeline clean.*

### The "S.O.S." Recovery (`reflog`)
If you ever execute a command that "deletes" your work (like `git reset`), Git actually keeps the data for ~30 days.
```bash
git reflog
```
Find the hash of the lost commit and use `git reset --hard <hash>` to bring it back.

---
> [!TIP]
> Keep this file in the root of your project to remind yourself (and future contributors) how to maintain a world-class development history.
