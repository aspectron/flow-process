const { spawn } = require('child_process');
const { EventEmitter } = require("events");

const dpc = (delay, fn)=>{
	if(typeof delay == 'function')
		return setTimeout(delay, fn||0);
	return setTimeout(fn, delay||0);
}

class FlowProcess extends EventEmitter {
    constructor(options) {
        super();

        this.options = Object.assign({
            relaunch : true,
            delay : 3000,
            tolerance : 5000,
            restarts : 0
        },options);

        this.logger = this.options.logger;
        this.relaunch = this.options.relaunch;
        this.delay = this.options.delay;
        this.restarts = 0;//this.options.restarts;
        this.tolerance = this.options.tolerance;
        this.ts = Date.now();
        this.kick = false;

        this.SIGTERM = this.createInterrupt('SIGTERM');
        this.SIGINT = this.createInterrupt('SIGINT');
        this.WAIT_FOR_EXIT = this.createInterrupt(null);
    }
    
    terminate(interrupt = 'SIGTERM') {
        if(this.restart_dpc) {
            clearTimeout(this.restart_dpc);
            delete this.restart_dpc;
        }

        const proc = this.process;
        delete this.process;
        this.relaunch = false;
        if(!proc)
            return Promise.resolve();

        return new Promise((resolve,reject) => {
            this.once('exit', (code) => {
                resolve(code);
            })
            proc.kill(interrupt);
            this.emit('halt');
            return Promise.resolve();
        });
    }

    restart(interrupt = 'SIGTERM') {
        if(this.process) {
            this.kick = true;
            this.process.kill(interrupt);
        }

        return Promise.resolve();
    }

    createInterrupt(interrupt) {
        return (t = 1e4, fallback = undefined) => {
            return new Promise((resolve, reject) => {

                if(this.restart_dpc) {
                    clearTimeout(this.restart_dpc);
                    delete this.restart_dpc;
                }

                if(!this.process)
                    return reject('not running');

                const ts = Date.now();
                let success = false;
                const exitHandler = (code) => {
                    success = true;
                    return resolve(code);
                }
                this.once('exit', exitHandler);
                this.relaunch = false;
                // console.log('...'+interrupt);
                if(interrupt)
                    this.process.kill(interrupt);

                const monitor = () => {
                    if(success)
                        return;
                    let d = Date.now() - ts;
                    if(d > t) {
                        this.off('exit', exitHandler);
                        if(fallback) {
                            return fallback().then(resolve,reject);
                        }
                        else {
                            return reject(`${interrupt || 'WAIT_FOR_EXIT'} timeout`);
                        }
                    }
                    dpc(30, monitor);
                }
                dpc(5, monitor);
            })
        }
    }

    run() {
        return new Promise((resolve, reject) => {
            delete this.restart_dpc;

            let fn_ = (typeof(this.options.args) == 'function');
            let args = fn_ ? this.options.args().slice() : this.options.args.slice();

            this.options.verbose && console.log("running:", args);

            if(this.process) {
                // throw new Error("Process is already running!");
                console.error("Process is already running",this);
                return reject('process is already running');
            }

            let proc = args.shift();
            this.name = this.options.name || proc;
            let cwd = this.options.cwd || process.cwd();
            let windowsHide = this.options.windowsHide;
            let detached = this.options.detached;
            let env = (this.options.env && Object.keys(this.options.env).length) ? this.options.env : undefined;

            //let filter = options.filter || function(data) { return data; };

            let filter_ = (data) => { return data; }
            let stdout = (typeof(this.options.stdout) == 'function') ? this.options.stdout : filter_;
            let stderr = (typeof(this.options.stderr) == 'function') ? this.options.stderr : filter_;

            // console.log(proc, args, { cwd, windowsHide });
            this.emit('start');
            this.process = spawn(proc, args, { cwd, windowsHide, detached, env });

            // Good example here for piping directly to log files: https://nodejs.org/api/child_process.html#child_process_options_detached
            if(this.options.pipe) {
                this.process.stdout.pipe(process.stdout);
                this.process.stderr.pipe(process.stderr);
                this.stdin = process.openStdin();
                this.stdin.pipe(this.process.stdin);
            }
            else 
            if(this.options.splitLines) {
                this.process.stdout.on('data',(data) => {
                     data.toString('utf8').split('\n').map( l => console.log(l) );
                    //process.stdout.write(data);
                    if(this.options.logger)
                        this.options.logger.write(data);
                });

                this.process.stderr.on('data',(data) => {
                     data.toString('utf8').split('\n').map( l => console.log(l) );
                    //process.stderr.write(data);
                    if(this.options.logger)
                        this.options.logger.write(data);
                });
            }
            else 
            {
                this.process.stdout.on('data',(data) => {
                    //console.log(data.toString('utf8'));
                    let text = stdout(data);
                    if(!this.mute && text)
                        process.stdout.write(text);
                    if(this.options.logger)
                        this.options.logger.write(data);
                });

                this.process.stderr.on('data',(data) => {
                    //console.error(data.toString('utf8'));
                    let text = stdout(data);
                    if(!this.mute && text)
                        process.stderr.write(text);
                    if(this.options.logger)
                        this.options.logger.write(data);
                });
            }

            this.process.on('exit', (code) => {
                this.emit('exit',code);
                let { name } = this;
                if(code && !this.options.no_warnings)
                    console.log(`WARNING - child ${name} exited with code ${code}`);
                delete this.process;
                let ts = Date.now();
                if(this.options.restarts && this.ts && (ts - this.ts) < this.tolerance) {
                    this.restarts++;
                }
                if(this.options.restarts && this.restarts == this.options.restarts) {
                    this.relaunch = false;
                    console.log(`Too many restarts ${this.restarts}/${this.options.restarts} ...giving up`);
                }
                this.ts = ts;
                if(this.relaunch) {
                    if(this.options.restarts && !this.kick)
                        console.log(`Restarting process '${name}': ${this.restarts}/${this.options.restarts} `);
                    else
                        console.log(`Restarting process '${name}'`);
                    this.restart_dpc = dpc(this.kick ? 0 : this.delay, () => {
                        this.kick = false;
                        if(this.relaunch)
                            this.run();
                    });
                }
                else {
                     this.emit('halt')
                }
            });

            resolve();
        })            
    }
}

module.exports = FlowProcess;