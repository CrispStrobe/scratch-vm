// Track loading time with timestamps and, if possible, the performance API.
if (window.performance) {
    performance.mark('Scratch.EvalStart');
}

// Declare the LoadingMiddleware class first
/**
 * LoadingMiddleware class to handle middleware during asset loading.
 */
class LoadingMiddleware {
    constructor() {
        this.middleware = [];
        this.host = null;
        this.original = null;
    }

    install(host, original) {
        this.host = host;
        this.original = original;
        const { middleware } = this;
        return function (...args) {
            let i = 0;
            const next = function (_args) {
                if (i >= middleware.length) {
                    return original.call(host, ..._args);
                }
                return middleware[i++](_args, next);
            };
            return next(args);
        };
    }

    push(middleware) {
        this.middleware.push(middleware);
    }
}

// Now we can safely use LoadingMiddleware
const importLoadCostume = require('../import/load-costume');
const costumeMiddleware = new LoadingMiddleware();
importLoadCostume.loadCostume = costumeMiddleware.install(importLoadCostume, importLoadCostume.loadCostume);

const importLoadSound = require('../import/load-sound');
const soundMiddleware = new LoadingMiddleware();
importLoadSound.loadSound = soundMiddleware.install(importLoadSound, importLoadSound.loadSound);

const ScratchStorage = require('scratch-storage');
const VirtualMachine = require('..');
const Runtime = require('../engine/runtime');

const ScratchRender = require('scratch-render');
const AudioEngine = require('scratch-audio');
const ScratchSVGRenderer = require('scratch-svg-renderer');

const Scratch = window.Scratch = window.Scratch || {};

const SLOW = 0.1;

const projectInput = document.querySelector('input');

// Declare canvas at the top level
const canvas = document.getElementById('scratch-stage');

/**
 * Event listener that calls runBenchmark.
 */
document.querySelector('.run').addEventListener('click', async () => {
    try {
        window.location.hash = projectInput.value;
        await runBenchmark();
    } catch (err) {
        console.error('Error running benchmark:', err);
    }
}, false);

/**
 * Set the share link based on benchmark data.
 * @param {object} json - Benchmark data.
 */
const setShareLink = function (json) {
    document.querySelector('.share')
        .href = `#view/${btoa(JSON.stringify(json))}`;
    document.querySelectorAll('.share')[1]
        .href = `suite.html`;
};

/**
 * Load the project from a local .sb3 file.
 * @returns {string} The project filename without extension.
 */
function loadProject() {
    let id = location.hash.substring(1).split(',')[0];
    if (!id || !id.length) {
        id = projectInput.value || 'default_project';
    }
    console.log('Loading project:', id);
    return id;
}

/**
 * Run the benchmark with given parameters in the location's hash field or
 * using defaults.
 */
async function runBenchmark() {
    try {
        const vm = new VirtualMachine();
        Scratch.vm = vm;

        vm.setTurboMode(true);

        const storage = new ScratchStorage();
        vm.attachStorage(storage);

        // Instantiate the renderer and connect it to the VM.
        Scratch.renderer = new ScratchRender(canvas);
        vm.attachRenderer(Scratch.renderer);
        vm.attachV2BitmapAdapter(new ScratchSVGRenderer.BitmapAdapter());

        // Initialize audio after user interaction
        const audioEngine = new AudioEngine();

        // Make sure audio context is resumed after creation
        if (audioEngine.audioContext && audioEngine.audioContext.state === 'suspended') {
            try {
                await audioEngine.audioContext.resume();
            } catch (err) {
                console.warn('Audio context failed to start:', err);
            }
        }

        vm.attachAudioEngine(audioEngine);

        new LoadingProgress(progress => {
            const setElement = (name, value) => {
                document.getElementsByClassName(name)[0].innerText = value;
            };
            const sinceLoadStart = key => (
                `(${(window[key] || Date.now()) - window.ScratchVMLoadStart}ms)`
            );

            setElement('loading-total', 1);
            setElement('loading-complete', progress.dataLoaded);
            setElement('loading-time', sinceLoadStart('ScratchVMLoadDataEnd'));

            setElement('loading-content-total', progress.contentTotal);
            setElement('loading-content-complete', progress.contentComplete);
            setElement('loading-content-time', sinceLoadStart('ScratchVMDownloadEnd'));

            setElement('loading-hydrate-total', progress.hydrateTotal);
            setElement('loading-hydrate-complete', progress.hydrateComplete);
            setElement('loading-hydrate-time', sinceLoadStart('ScratchVMLoadEnd'));

            if (progress.memoryPeak) {
                setElement('loading-memory-current',
                    `${(progress.memoryCurrent / 1000000).toFixed(0)}MB`
                );
                setElement('loading-memory-peak',
                    `${(progress.memoryPeak / 1000000).toFixed(0)}MB`
                );
            }
        }).on(storage, vm);

        let warmUpTime = 4000;
        let maxRecordedTime = 6000;

        if (location.hash) {
            const split = location.hash.substring(1).split(',');
            if (split[1] && split[1].length > 0) {
                warmUpTime = Number(split[1]);
            }
            maxRecordedTime = Number(split[2] || '0') || 6000;
        }

        // Load the local project file
        const projectId = loadProject();
        const response = await fetch(`${projectId}.sb3`);
        if (!response.ok) {
            throw new Error(`Failed to load project: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        await vm.loadProject(arrayBuffer);

        new ProfilerRun({
            vm,
            warmUpTime,
            maxRecordedTime
        }).run();

        // Feed mouse events as VM I/O events.
        document.addEventListener('mousemove', e => {
            const rect = canvas.getBoundingClientRect();
            const coordinates = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                canvasWidth: rect.width,
                canvasHeight: rect.height
            };
            Scratch.vm.postIOData('mouse', coordinates);
        });
        canvas.addEventListener('mousedown', e => {
            const rect = canvas.getBoundingClientRect();
            const data = {
                isDown: true,
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                canvasWidth: rect.width,
                canvasHeight: rect.height
            };
            Scratch.vm.postIOData('mouse', data);
            e.preventDefault();
        });
        canvas.addEventListener('mouseup', e => {
            const rect = canvas.getBoundingClientRect();
            const data = {
                isDown: false,
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                canvasWidth: rect.width,
                canvasHeight: rect.height
            };
            Scratch.vm.postIOData('mouse', data);
            e.preventDefault();
        });

        // Feed keyboard events as VM I/O events.
        document.addEventListener('keydown', e => {
            // Don't capture keys intended for inputs.
            if (e.target !== document && e.target !== document.body) {
                return;
            }
            Scratch.vm.postIOData('keyboard', {
                keyCode: e.keyCode,
                isDown: true
            });
            e.preventDefault();
        });
        document.addEventListener('keyup', e => {
            // Always capture up events,
            // even those that have switched to other targets.
            Scratch.vm.postIOData('keyboard', {
                keyCode: e.keyCode,
                isDown: false
            });
            // E.g., prevent scroll.
            if (e.target !== document && e.target !== document.body) {
                e.preventDefault();
            }
        });

        // Run threads
        vm.start();
    } catch (err) {
        console.error('Error in runBenchmark:', err);
        throw err;
    }
}

/**
 * LoadingProgress class to track and report loading progress.
 */
class LoadingProgress {
    constructor(callback) {
        this.dataLoaded = 0;
        this.contentTotal = 0;
        this.contentComplete = 0;
        this.hydrateTotal = 0;
        this.hydrateComplete = 0;
        this.memoryCurrent = 0;
        this.memoryPeak = 0;
        this.callback = callback;
    }

    sampleMemory() {
        if (window.performance && window.performance.memory) {
            this.memoryCurrent = window.performance.memory.usedJSHeapSize;
            this.memoryPeak = Math.max(this.memoryCurrent, this.memoryPeak);
        }
    }

    attachHydrateMiddleware(middleware) {
        const _this = this;
        middleware.push((args, next) => {
            _this.hydrateTotal += 1;
            _this.sampleMemory();
            _this.callback(_this);
            return Promise.resolve(next(args))
                .then(value => {
                    _this.hydrateComplete += 1;
                    _this.sampleMemory();
                    _this.callback(_this);
                    return value;
                });
        });
    }

    on(storage, vm) {
        const _this = this;

        this.attachHydrateMiddleware(costumeMiddleware);
        this.attachHydrateMiddleware(soundMiddleware);

        const _load = storage.webHelper.load;
        storage.webHelper.load = function (...args) {
            if (_this.dataLoaded === 0 && window.performance) {
                // Mark in browser inspectors how long it takes to load the
                // project's initial data file.
                performance.mark('Scratch.LoadDataStart');
            }

            const result = _load.call(this, ...args);

            if (_this.dataLoaded) {
                if (_this.contentTotal === 0 && window.performance) {
                    performance.mark('Scratch.DownloadStart');
                }

                _this.contentTotal += 1;
            }
            _this.sampleMemory();
            _this.callback(_this);

            result.then(() => {
                if (_this.dataLoaded === 0) {
                    if (window.performance) {
                        // How long did loading the data file take?
                        performance.mark('Scratch.LoadDataEnd');
                        performance.measure('Scratch.LoadData', 'Scratch.LoadDataStart', 'Scratch.LoadDataEnd');
                    }

                    _this.dataLoaded = 1;

                    window.ScratchVMLoadDataEnd = Date.now();
                } else {
                    _this.contentComplete += 1;
                }

                if (_this.contentComplete && _this.contentComplete === _this.contentTotal) {
                    if (window.performance) {
                        // How long did it take to download all project assets?
                        performance.mark('Scratch.DownloadEnd');
                        performance.measure('Scratch.Download', 'Scratch.DownloadStart', 'Scratch.DownloadEnd');
                    }

                    window.ScratchVMDownloadEnd = Date.now();
                }

                _this.sampleMemory();
                _this.callback(_this);
            });
            return result;
        };
        vm.runtime.on(Runtime.PROJECT_LOADED, () => {
            if (window.performance) {
                // How long did it take to load and hydrate all assets?
                performance.mark('Scratch.LoadEnd');
                performance.measure('Scratch.Load', 'Scratch.LoadStart', 'Scratch.LoadEnd');
            }

            window.ScratchVMLoadEnd = Date.now();

            // Update LoadingProgress a final time
            _this.sampleMemory();
            _this.callback(_this);
        });
    }
}

/**
 * StatView class to represent statistical data for a specific item.
 */
class StatView {
    constructor(name) {
        this.name = name;
        this.executions = 0;
        this.selfTime = 0;
        this.totalTime = 0;
    }

    update(selfTime, totalTime, count) {
        this.executions += count;
        this.selfTime += selfTime;
        this.totalTime += totalTime;
    }

    render({ table, isSlow }) {
        const row = document.createElement('tr');
        let cell = document.createElement('td');
        cell.innerText = this.name;
        row.appendChild(cell);

        if (isSlow(this)) {
            row.setAttribute('class', 'slow');
        }

        cell = document.createElement('td');
        cell.style.textAlign = 'right';
        cell.innerText = '---';
        // Truncate selfTime.
        this.selfTime = Math.floor(this.selfTime * 1000) / 1000;
        if (this.selfTime > 0) {
            cell.innerText = (this.selfTime / 1000).toFixed(3);
        }
        row.appendChild(cell);

        cell = document.createElement('td');
        cell.style.textAlign = 'right';
        cell.innerText = '---';
        // Truncate totalTime.
        this.totalTime = Math.floor(this.totalTime * 1000) / 1000;
        if (this.totalTime > 0) {
            cell.innerText = (this.totalTime / 1000).toFixed(3);
        }
        row.appendChild(cell);

        cell = document.createElement('td');
        cell.style.textAlign = 'right';
        cell.innerText = this.executions;
        row.appendChild(cell);

        table.appendChild(row);
    }
}

/**
 * StatTable class to manage and render a table of statistics.
 */
class StatTable {
    constructor({ table, keys, viewOf, isSlow }) {
        this.table = table;
        this.keys = keys;
        this.viewOf = viewOf;
        this.isSlow = isSlow;
    }

    render() {
        const table = this.table;
        Array.from(table.children)
            .forEach(node => table.removeChild(node));
        const keys = this.keys();
        for (const key of keys) {
            this.viewOf(key).render({
                table,
                isSlow: frame => this.isSlow(key, frame)
            });
        }
    }
}

/**
 * RunningStats class to collect statistics during VM execution.
 */
class RunningStats {
    constructor(profiler) {
        this.stepThreadsInnerId = profiler.idByName('Sequencer.stepThreads#inner');
        this.blockFunctionId = profiler.idByName('blockFunction');
        this.stepThreadsId = profiler.idByName('Sequencer.stepThreads');

        this.recordedTime = 0;
        this.executed = {
            steps: 0,
            blocks: 0
        };
    }

    update(id, arg, selfTime, totalTime, count) {
        if (id === this.stepThreadsId) {
            this.recordedTime += totalTime;
        } else if (id === this.stepThreadsInnerId) {
            this.executed.steps += count;
        } else if (id === this.blockFunctionId) {
            this.executed.blocks += count;
        }
    }
}

/**
 * RunningStatsView class to display running statistics.
 */
class RunningStatsView {
    constructor({ dom, runningStats, maxRecordedTime }) {
        this.dom = dom;
        this.runningStats = runningStats;
        this.maxRecordedTime = maxRecordedTime;
    }

    render() {
        const { dom, runningStats, maxRecordedTime } = this;
        dom.querySelector('.profile-count-steps').innerText = runningStats.executed.steps;
        dom.querySelector('.profile-count-blocks').innerText = runningStats.executed.blocks;
        dom.querySelector('.profile-count-time').innerText = (runningStats.recordedTime / 1000).toFixed(3);

        const progress = Math.min(runningStats.recordedTime / maxRecordedTime, 1) * 100;
        dom.querySelector('.profile-count-progress').style.width = `${progress}%`;
    }
}

/**
 * ProfilerRun class to manage the profiling run.
 */
class ProfilerRun {
    constructor({ vm, maxRecordedTime, warmUpTime }) {
        this.vm = vm;
        this.maxRecordedTime = maxRecordedTime;
        this.warmUpTime = warmUpTime;

        vm.runtime.enableProfiling();
        const profiler = this.profiler = vm.runtime.profiler;
        vm.runtime.profiler = null;

        const runningStats = this.runningStats = new RunningStats(profiler);
        const runningStatsView = this.runningStatsView = new RunningStatsView({
            dom: document.getElementsByClassName('profile-count-group')[0],
            runningStats,
            maxRecordedTime
        });

        const frames = this.frames = new Frames(profiler);
        this.frameTable = new FramesTable({
            table: document
                .getElementsByClassName('profile-count-frame-table')[0]
                .getElementsByTagName('tbody')[0],
            profiler,
            frames
        });

        const opcodes = this.opcodes = new Opcodes(profiler);
        this.opcodeTable = new OpcodeTable({
            table: document
                .getElementsByClassName('profile-count-opcode-table')[0]
                .getElementsByTagName('tbody')[0],
            profiler,
            opcodes,
            frames
        });

        const stepId = profiler.idByName('Runtime._step');
        profiler.onFrame = ({ id, arg, selfTime, totalTime, count }) => {
            if (id === stepId) {
                runningStatsView.render();
            }

            runningStats.update(id, arg, selfTime, totalTime, count);
            opcodes.update(id, arg, selfTime, totalTime, count);
            frames.update(id, arg, selfTime, totalTime, count);
        };
    }

    run() {
        this.projectId = loadProject();

        window.parent.postMessage({
            type: 'BENCH_MESSAGE_LOADING'
        }, '*');

        this.vm.on('workspaceUpdate', () => {
            setTimeout(() => {
                window.parent.postMessage({
                    type: 'BENCH_MESSAGE_WARMING_UP'
                }, '*');
                this.vm.greenFlag();
            }, 100);
            setTimeout(() => {
                window.parent.postMessage({
                    type: 'BENCH_MESSAGE_ACTIVE'
                }, '*');
                this.vm.runtime.profiler = this.profiler;
            }, 100 + this.warmUpTime);
            setTimeout(() => {
                this.vm.stopAll();
                clearTimeout(this.vm.runtime._steppingInterval);
                this.vm.runtime.profiler = null;

                this.frameTable.render();
                this.opcodeTable.render();

                window.parent.postMessage({
                    type: 'BENCH_MESSAGE_COMPLETE',
                    frames: this.frames.frames,
                    opcodes: this.opcodes.opcodes
                }, '*');

                setShareLink({
                    fixture: {
                        projectId: this.projectId,
                        warmUpTime: this.warmUpTime,
                        recordingTime: this.maxRecordedTime
                    },
                    frames: this.frames.frames,
                    opcodes: this.opcodes.opcodes
                });
            }, 100 + this.warmUpTime + this.maxRecordedTime);
        });
    }

    render(json) {
        const { fixture } = json;
        document.querySelector('[type=text]').value = [
            fixture.projectId,
            fixture.warmUpTime,
            fixture.recordingTime
        ].join(',');

        this.frames.frames = json.frames.map(
            frame => Object.assign(new StatView(), frame, {
                name: this.profiler.nameById(this.profiler.idByName(frame.name))
            })
        );

        this.opcodes.opcodes = {};
        Object.entries(json.opcodes).forEach(([opcode, data]) => {
            this.opcodes.opcodes[opcode] = Object.assign(new StatView(), data);
        });

        this.frameTable.render();
        this.opcodeTable.render();
    }
}

/**
 * Frames class to collect frame data during profiling.
 */
class Frames {
    constructor(profiler) {
        this.profiler = profiler;
        this.frames = [];
    }

    update(id, arg, selfTime, totalTime, count) {
        const name = this.profiler.nameById(id);
        let frame = this.frames.find(f => f.name === name);
        if (!frame) {
            frame = new StatView(name);
            this.frames.push(frame);
        }
        frame.update(selfTime, totalTime, count);
    }
}

/**
 * FramesTable class to render frames data.
 */
class FramesTable {
    constructor({ table, profiler, frames }) {
        this.table = table;
        this.profiler = profiler;
        this.frames = frames;
    }

    render() {
        const sortedFrames = this.frames.frames.sort((a, b) => b.selfTime - a.selfTime);
        const keys = sortedFrames.map(frame => frame.name);

        const statTable = new StatTable({
            table: this.table,
            keys: () => keys,
            viewOf: name => this.frames.frames.find(frame => frame.name === name),
            isSlow: (key, frame) => frame.selfTime > SLOW
        });

        statTable.render();
    }
}

/**
 * Opcodes class to collect opcode execution data.
 */
class Opcodes {
    constructor(profiler) {
        this.profiler = profiler;
        this.opcodes = {};
    }

    update(id, arg, selfTime, totalTime, count) {
        if (arg && arg.opcode) {
            const opcode = arg.opcode;
            let stat = this.opcodes[opcode];
            if (!stat) {
                stat = new StatView(opcode);
                this.opcodes[opcode] = stat;
            }
            stat.update(selfTime, totalTime, count);
        }
    }
}

/**
 * OpcodeTable class to render opcode execution data.
 */
class OpcodeTable {
    constructor({ table, profiler, opcodes, frames }) {
        this.table = table;
        this.profiler = profiler;
        this.opcodes = opcodes;
        this.frames = frames;
    }

    render() {
        const sortedOpcodes = Object.keys(this.opcodes.opcodes).sort((a, b) => {
            return this.opcodes.opcodes[b].selfTime - this.opcodes.opcodes[a].selfTime;
        });

        const statTable = new StatTable({
            table: this.table,
            keys: () => sortedOpcodes,
            viewOf: opcode => this.opcodes.opcodes[opcode],
            isSlow: (key, frame) => frame.selfTime > SLOW
        });

        statTable.render();
    }
}

/**
 * Render previously run benchmark data.
 * @param {object} json - Data from a previous benchmark run.
 */
function renderBenchmarkData(json) {
    const vm = new VirtualMachine();
    new ProfilerRun({ vm }).render(json);
    setShareLink(json);
}

function onload() {
    if (location.hash.substring(1).startsWith('view')) {
        document.body.className = 'render';
        const data = location.hash.substring(6);
        const frozen = atob(data);
        const json = JSON.parse(frozen);
        renderBenchmarkData(json);
    } else {
        // Wait for user interaction before running benchmark
        console.log('Click "run" to start benchmark');
    }
}

window.onhashchange = function () {
    location.reload();
};

if (window.performance) {
    performance.mark('Scratch.EvalEnd');
    performance.measure('Scratch.Eval', 'Scratch.EvalStart', 'Scratch.EvalEnd');
}

window.ScratchVMEvalEnd = Date.now();

onload();
