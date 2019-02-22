const babel = require("rollup-plugin-babel");
const replace = require("rollup-plugin-replace");
const commonjs = require("rollup-plugin-commonjs");
const nodeResolve = require("rollup-plugin-node-resolve");
const { sizeSnapshot } = require("rollup-plugin-size-snapshot");
const { uglify } = require("rollup-plugin-uglify");

const pkg = require("./package.json");

function isBareModuleId(id) {
  return !id.startsWith(".") && !id.startsWith("/");
}

const cjs = [
  {
    input: "modules/index.js",
    output: { file: `cjs/${pkg.name}.js`, format: "cjs" },
    external: isBareModuleId,
    plugins: [
      babel({ exclude: /node_modules/ }),
      replace({
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.env.BUILD_FORMAT": JSON.stringify("cjs")
      })
    ]
  },
  {
    input: "modules/index.js",
    output: { file: `cjs/${pkg.name}.min.js`, format: "cjs" },
    external: isBareModuleId,
    plugins: [
      babel({ exclude: /node_modules/ }),
      replace({
        "process.env.NODE_ENV": JSON.stringify("production"),
        "process.env.BUILD_FORMAT": JSON.stringify("cjs")
      }),
      uglify()
    ]
  }
];

const esm = [
  {
    input: "modules/index.js",
    output: { file: `esm/${pkg.name}.js`, format: "esm" },
    external: isBareModuleId,
    plugins: [
      babel({
        exclude: /node_modules/,
        runtimeHelpers: true,
        plugins: [["@babel/transform-runtime", { useESModules: true }]]
      }),
      replace({ "process.env.BUILD_FORMAT": JSON.stringify("esm") }),
      sizeSnapshot()
    ]
  }
];

const globals = { react: "React" };

const umd = [
  {
    input: "modules/index.js",
    output: {
      file: `umd/${pkg.name}.js`,
      format: "umd",
      name: "ReactRouter",
      globals
    },
    external: Object.keys(globals),
    plugins: [
      babel({
        exclude: /node_modules/,
        runtimeHelpers: true,
        plugins: [["@babel/transform-runtime", { useESModules: true }]]
      }),
      nodeResolve(),
      commonjs({
        include: /node_modules/,
        namedExports: {
          "node_modules/react-is/index.js": ["isValidElementType"]
        }
      }),
      replace({
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.env.BUILD_FORMAT": JSON.stringify("umd")
      }),
      sizeSnapshot()
    ]
  },
  {
    input: "modules/index.js",
    output: {
      file: `umd/${pkg.name}.min.js`,
      format: "umd",
      name: "ReactRouter",
      globals
    },
    external: Object.keys(globals),
    plugins: [
      babel({
        exclude: /node_modules/,
        runtimeHelpers: true,
        plugins: [["@babel/transform-runtime", { useESModules: true }]]
      }),
      nodeResolve(),
      commonjs({
        include: /node_modules/,
        namedExports: {
          "node_modules/react-is/index.js": ["isValidElementType"]
        }
      }),
      replace({
        "process.env.NODE_ENV": JSON.stringify("production"),
        "process.env.BUILD_FORMAT": JSON.stringify("umd")
      }),
      sizeSnapshot(),
      uglify()
    ]
  }
];

let config;
switch (process.env.BUILD_ENV) {
  case "cjs":
    config = cjs;
    break;
  case "esm":
    config = esm;
    break;
  case "umd":
    config = umd;
    break;
  default:
    config = cjs.concat(esm).concat(umd);
}

module.exports = config;
