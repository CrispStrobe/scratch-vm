const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ScratchWebpackConfigBuilder = require('scratch-webpack-configuration');

const common = {
    libraryName: 'scratch-vm',
    rootPath: path.resolve(__dirname)
};

// Function to create audio rules
const createAudioRules = buildType => ({
    test: /\.(mp3|wav|ogg)$/,
    loader: 'file-loader',
    options: {
        name: resourcePath => {
            const relativePath = path.relative(
                path.join(__dirname, 'src'),
                resourcePath
            );
            // Include a hash in the filename to make it unique
            return `static/assets/${buildType}/[hash]-${relativePath.replace(/[\\/]/g, '-')}`;
        },
        esModule: false
    }
});

// Function to create arrayBuffer rules
const createArrayBufferRule = buildType => ({
    resourceQuery: /arrayBuffer/,
    type: 'asset/resource',
    generator: {
        filename: pathData => {
            const relativePath = path.relative(
                path.join(__dirname, 'src'),
                pathData.filename
            );
            return `static/assets/${buildType}/[hash]-${relativePath.replace(/[\\/]/g, '-')}`;
        }
    }
});

const nodeBuilder = new ScratchWebpackConfigBuilder(common)
    .setTarget('node')
    .merge({
        entry: {
            'extension-worker': path.join(__dirname, 'src/extension-support/extension-worker.js')
        },
        output: {
            path: path.resolve(__dirname, 'dist'),
            library: {
                type: 'umd',
                name: 'VirtualMachine'
            },
            uniqueName: 'node'
        }
    })
    .addModuleRule(createAudioRules('node'))
    .addModuleRule(createArrayBufferRule('node'));

const webBuilder = new ScratchWebpackConfigBuilder(common)
    .setTarget('browserslist')
    .merge({
        entry: {
            'extension-worker': path.join(__dirname, 'src/extension-support/extension-worker.js')
        },
        resolve: {
            fallback: {
                Buffer: require.resolve('buffer/')
            }
        },
        output: {
            path: path.resolve(__dirname, 'dist'),
            library: {
                type: 'umd',
                name: 'VirtualMachine'
            },
            uniqueName: 'web'
        }
    })
    .addModuleRule({
        test: require.resolve('./src/index.js'),
        loader: 'expose-loader',
        options: {
            exposes: 'VirtualMachine'
        }
    })
    .addModuleRule(createAudioRules('web'))
    .addModuleRule(createArrayBufferRule('web'));

const playgroundBuilder = webBuilder.clone();
const playgroundConfig = {
    ...playgroundBuilder.get(),
    mode: 'development',
    devtool: 'source-map',
    devServer: {
        static: {
            directory: path.join(__dirname, 'playground')
        },
        host: '0.0.0.0',
        port: process.env.PORT || 8073,
        allowedHosts: 'all',
        client: {
            overlay: true,
            logging: 'warn'
        },
        devMiddleware: {
            stats: 'minimal'
        }
    },
    performance: {
        hints: false
    },
    entry: {
        'benchmark': './src/playground/benchmark',
        'video-sensing-extension-debug': './src/extensions/scratch3_video_sensing/debug',
        'extension-worker': path.join(__dirname, 'src/extension-support/extension-worker.js')
    },
    output: {
        path: path.resolve(__dirname, 'playground'),
        filename: '[name].js',
        library: {
            type: 'umd',
            name: 'VirtualMachine'
        },
        uniqueName: 'playground',
        clean: true
    },
    module: {
        rules: [
            ...(playgroundBuilder.get().module?.rules || []),
            createAudioRules('playground'),
            createArrayBufferRule('playground'),
            {
                test: require.resolve('stats.js/build/stats.min.js'),
                loader: 'script-loader'
            },
            {
                test: require.resolve('./src/extensions/scratch3_video_sensing/debug.js'),
                loader: 'expose-loader',
                options: {
                    exposes: 'Scratch3VideoSensingDebug'
                }
            },
            {
                test: require.resolve('scratch-blocks/dist/vertical.js'),
                loader: 'expose-loader',
                options: {
                    exposes: 'Blockly'
                }
            },
            {
                test: require.resolve('scratch-audio/src/index.js'),
                loader: 'expose-loader',
                options: {
                    exposes: 'AudioEngine'
                }
            },
            {
                test: require.resolve('scratch-storage/src/index.js'),
                loader: 'expose-loader',
                options: {
                    exposes: 'ScratchStorage'
                }
            },
            {
                test: require.resolve('scratch-render'),
                loader: 'expose-loader',
                options: {
                    exposes: 'ScratchRender'
                }
            }
        ]
    },
    plugins: [
        ...(playgroundBuilder.get().plugins || []),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: 'node_modules/scratch-blocks/media',
                    to: 'media'
                },
                {
                    from: 'node_modules/scratch-storage/dist/web'
                },
                {
                    from: 'node_modules/scratch-render/dist/web'
                },
                {
                    from: 'node_modules/scratch-svg-renderer/dist/web'
                },
                {
                    from: 'src/playground'
                }
            ]
        })
    ]
};

module.exports = [
    nodeBuilder.get(),
    webBuilder.get(),
    playgroundConfig
];
