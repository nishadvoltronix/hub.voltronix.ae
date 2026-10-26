console.error("BLOCKED: db:* no longer selects SQLite implicitly. Preserved SQLite tooling is explicitly named sqlite:*. The active application uses MySQL; migrations require a separate reviewed local operation.");
process.exitCode = 1;
