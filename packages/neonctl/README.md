# `neonctl`

`neonctl` is the compatibility command for the [Neon CLI](https://www.npmjs.com/package/neon).
New installations should use the `neon` package and the `neon` command:

```shell
npm install --global neon
neon --help
```

Existing scripts can continue to install `neonctl` and invoke `neonctl`. This
package contains only a small executable shim and depends on `neon`, where the
CLI implementation lives:

```shell
npm install --global neonctl
neonctl --help
```

The shim imports the `neon/cli` entry point in the same Node.js process, so
arguments, standard input/output, signals, and exit behavior remain those of the
primary CLI without duplicating its source or build output.
