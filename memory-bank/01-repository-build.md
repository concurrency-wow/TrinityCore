# Repository and Build Architecture

## Repository topology

| Path | Responsibility |
|---|---|
| `CMakeLists.txt` | Root configuration, dependencies, source tree, and CTest |
| `cmake/` | Options, compiler/platform policy, discovery macros, revision generation |
| `dep/` | Vendored dependencies and wrappers for external dependencies |
| `src/common/` | Config, logging, crypto, Asio wrappers, threading, containers, utilities |
| `src/server/database/` | MySQL pools, statements, transactions, callbacks, updater |
| `src/server/shared/` | Networking, realms, shared stores, and secrets |
| `src/server/game/` | World simulation and gameplay implementation |
| `src/server/scripts/` | Commands, spells, encounters, zones, and custom modules |
| `src/server/authserver/` | Authentication executable and protocol |
| `src/server/worldserver/` | World executable, CLI, Remote Access, and SOAP |
| `src/tools/` | Map, vmap, and mmap extraction/generation tools |
| `sql/` | Base schemas, current updates, custom updates, and archived history |
| `tests/` | Catch2 tests linked against `game` |
| `contrib/` | SQL/style checks, Docker, extraction, debugging, and generators |
| `.github/workflows/`, `.circleci/` | Build and validation matrices |

`generated-ai-tools/` and `rebuild.sh` are untracked local additions in this
checkout and are not part of the upstream topology.

## Build contract

The root build rejects source-tree mutation and in-source builds through
`CMAKE_DISABLE_SOURCE_CHANGES` and `CMAKE_DISABLE_IN_SOURCE_BUILD`.

| Requirement | Enforced by |
|---|---|
| CMake 3.18+ | Root `cmake_minimum_required()` |
| C++20, compiler extensions off | `cmake/macros/ConfigureBaseTargets.cmake` |
| GCC 11.1.0+ | `cmake/compiler/gcc/settings.cmake` |
| Clang 11.0.0+ | `cmake/compiler/clang/settings.cmake` |
| AppleClang 12.0.5+ | `cmake/compiler/clang/settings.cmake` |
| MSVC 19.32 / VS 2022 17.2+ | `cmake/compiler/msvc/settings.cmake` |
| Boost 1.74+ non-Windows, 1.78+ Windows | `dep/boost/CMakeLists.txt` |
| MySQL 8.0.34+ or MariaDB 10.6.3+ | `dep/mysql/CMakeLists.txt`, pool startup checks |
| MySQL client executable for updates | `DBUpdaterUtil::CheckExecutable()` |

Explicitly linked Boost components are filesystem, program options, regex,
and locale. Header APIs also use Asio/System, Process, DLL, Stacktrace,
Container, Circular Buffer, Accumulators, Heap, Dynamic Bitset, Endian, and
utility algorithms.

## Normal build workflow

A portable Ninja build with tests is:

```bash
cmake -S . -B build -GNinja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DSERVERS=ON \
  -DTOOLS=ON \
  -DSCRIPTS=static \
  -DBUILD_TESTING=ON

cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

Configure the install prefix before compilation. On Unix, server binaries
compile their default config path from `CONF_DIR`, whose default is
`${CMAKE_INSTALL_PREFIX}/etc`:

```bash
cmake -S . -B build -GNinja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_INSTALL_PREFIX=/opt/trinitycore

cmake --build build --parallel
cmake --install build
```

For multi-configuration generators, add `--config RelWithDebInfo` to build,
test, and install commands. `RelWithDebInfo` is the root default when no build
type is supplied. Prefer CI workflows over potentially stale prose examples:
`.github/workflows/linux-build.yml`, `win-x64-build.yml`, and
`macos-arm-build.yml`.

## Principal options

Declared options live in `cmake/options.cmake`.

| Option | Default | Meaning |
|---|---:|---|
| `SERVERS` | ON | Build `authserver` and `worldserver` |
| `TOOLS` | ON | Build map/vmap/mmap tools |
| `SCRIPTS` | `static` | Script linkage preset |
| `USE_COREPCH` | ON | Core precompiled headers |
| `USE_SCRIPTPCH` | ON | Script precompiled headers |
| `WITH_DYNAMIC_LINKING` | OFF | Shared core/script linkage |
| `WITH_FILESYSTEM_WATCHER` | OFF | Include filesystem watcher support |
| `WITH_WARNINGS` | OFF | Enable broader warning sets |
| `WITH_WARNINGS_AS_ERRORS` | OFF | Treat enabled warnings as errors |
| `WITH_COREDEBUG` | OFF | Add extra debug instrumentation |
| `WITHOUT_METRICS` | OFF | Disable metrics |
| `WITH_DETAILED_METRICS` | OFF | Enable detailed session timing |
| `COPY_CONF` | ON | Copy/install `.conf.dist` files |
| `WITHOUT_GIT` | OFF | Disable Git-derived revision metadata |
| `BUILD_TESTING` | OFF | Fetch Catch2 and build tests |
| `WITH_SOURCE_TREE` | `hierarchical` | IDE source grouping |

`SCRIPTS` accepts `none`, `static`, `dynamic`, `minimal-static`, or
`minimal-dynamic`. Minimal presets whitelist `Commands` and `Spells` in
`src/server/scripts/CMakeLists.txt`.

Per-module variables such as `SCRIPTS_CUSTOM` accept `default`, `disabled`,
`static`, or `dynamic`. Dynamic modules force shared-linking support where
needed through `IsDynamicLinkingRequired()` in
`cmake/macros/ConfigureScripts.cmake`.

Compiler files consume `ASAN`; Clang also consumes `MSAN`, `UBSAN`, and
`TSAN`. These are not normal `option()` entries but command-line cache values
such as `-DASAN=ON` activate them. Valgrind and Helgrind support is reported by
`cmake/showoptions.cmake`.

## Target and dependency graph

```text
revision_data.h
       |
     common
       |
    database
       |
     shared --------------------> authserver
       |
 game-interface
       |
      game
       |
    scripts --------------------> worldserver
```

- `common` exposes common third-party facilities and depends on generated
  `revision_data.h`; see `src/common/CMakeLists.txt`.
- `database` links MySQL privately and `common` publicly.
- `shared` exposes `database`.
- `game-interface` exposes includes plus `shared` and Detour; `game`
  implements it.
- `scripts` aggregates statically selected modules. Dynamic modules become
  shared libraries linked to `game`.
- `worldserver` links `scripts`, `game`, gSOAP, and readline.
- `authserver` links `shared`.
- `tests` links `game`, `trinity-core-interface`, and Catch2.
- Tools include `mapextractor`, `vmap4extractor`, `vmap4assembler`, and
  `mmaps_generator`.

`dep/CMakeLists.txt` composes threads, Boost, zlib, G3D-lite, Recast/Detour,
fmt, SFMT, utf8cpp, OpenSSL, Argon2, short_alloc, and platform dependencies.
Server builds add MySQL, readline, and gSOAP; tools add bzip2 and libmpq.

## Source discovery: reconfigure after file changes

`CollectSourceFiles()` in `cmake/macros/AutoCollect.cmake` recursively runs
`file(GLOB ...)` during configuration. It does not use `CONFIGURE_DEPENDS`.

```bash
# After creating, deleting, or moving a source file:
cmake -S . -B build
cmake --build build --parallel
```

A build-only command compiles edits to known files but does not reliably
discover a new `.cpp`. Top-level script modules are also found by a
configure-time glob in `GetScriptModuleList()`.

## Script-loader generation

`src/server/scripts/CMakeLists.txt` calls `ConfigureScriptLoader()` with
`src/server/scripts/ScriptLoader.cpp.in.cmake`. Generated loaders are written
under:

```text
<build>/src/server/scripts/gen_scriptloader/<module>/ScriptLoader.cpp
```

Do not edit generated loaders. Their `AddScripts()` calls module-level loaders
such as `AddCustomScripts()`.

The checked-in Custom module maintains
`src/server/scripts/Custom/custom_script_loader.cpp` manually. A custom script
normally needs:

1. A registration function such as `void AddSC_example();`.
2. A declaration and invocation inside `AddCustomScripts()`.
3. Any matching world-data `ScriptName`.
4. CMake reconfiguration if its source file is new.

Static scripts are compiled into `scripts` and linked into `worldserver`.
Dynamic modules export `AddScripts()`, revision hash, module name, and build
directive from the generated template.

## Generated artifacts

| Artifact | Policy |
|---|---|
| `<build>/revision_data.h` | Generated by target `revision_data.h`; template is `revision_data.h.in.cmake` |
| Build-tree script loaders | Generated by CMake; never hand-edit |
| `src/server/game/Entities/Object/Updates/UpdateFields.h` | Checked-in generated 3.3.5.12340 protocol data |
| `enuminfo_*.cpp` | Checked-in generated enum descriptions |
| `.conf.dist` copies | Build/install outputs from checked-in distributions |

Regenerate enum descriptions from `src/` as required by
`contrib/enumutils_describe.py`:

```bash
cd src
python ../contrib/enumutils_describe.py
```

Treat checked-in generated files as source artifacts: change their generator
or inputs rather than allowing arbitrary manual drift.

## Outputs and installation

On Unix, `cmake/platform/unix/settings.cmake` places products under:

```text
<build>/bin/<configuration>/bin
<build>/bin/<configuration>/lib
```

Servers install to `bin`, shared libraries to `lib`, config distributions to
`CONF_DIR`, and dynamic scripts to `<prefix>/bin/scripts`.

On Windows, runtime output is `<build>/bin/<configuration>`; servers and DLLs
install at the prefix root and dynamic scripts use `scripts/`.

With `COPY_CONF=ON`, post-build commands copy `authserver.conf.dist` and
`worldserver.conf.dist` into build output. Copy a distribution to its
non-`.dist` name and keep local secrets out of version control.

## Tests and CI

`BUILD_TESTING=ON` fetches Catch2 2.13.9 from GitHub at configure time, so the
first test configuration requires network access. `tests/CMakeLists.txt`
creates one `tests` executable and registers discovered cases with CTest.

At the audited snapshot, tests cover configuration, timers, strings,
`EventMap`, trackable pointers, chat commands, hyperlinks, and selected
container/threat behavior. No focused auth/network fuzzing, updater
state-machine, DB shutdown-drain, or script-integration suite was found.

CI coverage includes:

- Ubuntu GCC 13 and Clang 17, PCH on/off, dynamic scripts, tools, tests,
  install, and binary checks: `.github/workflows/linux-build.yml`.
- Windows VS 2022/Ninja: `.github/workflows/win-x64-build.yml`.
- macOS ARM static scripts, tests, install, and binary checks:
  `.github/workflows/macos-arm-build.yml`.
- CircleCI codestyle, SQL checks, development-world migrations, builds,
  tests, install, and Docker packaging: `.circleci/config.yml`.

## Style and contribution checks

`.editorconfig` specifies four spaces, no tabs, trailing-whitespace removal, a
final newline, and an 80-column preference. C/C++ files are declared Latin-1;
other files use UTF-8.

`contrib/check_codestyle.sh` is narrower than a formatter. It rejects tabs,
trailing whitespace, repeated blank lines, and selected
`ObjectGuid::GetCounter()` logging. No checked-in clang-format, clang-tidy, or
cppcheck configuration was found.

New source files should use `doc/FileHeaders.txt`. SQL naming and base-update
expectations are documented in `CONTRIBUTING.md`.

## Local helper warning

The untracked `rebuild.sh` requires an existing `build/CMakeCache.txt`, cleans
and builds selected targets, and moves server binaries to `/home/czirz/server`.
It does not rerun CMake, so it cannot discover new source files by itself. Its
related `README.md` section is also a local modification.
