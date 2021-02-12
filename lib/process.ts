import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

 const dpc = (delay: number | Function, fn ? : Function | number) : NodeJS.Timeout => {
    if (typeof delay == 'function') {
        let temp = fn as number;
        fn = delay;
        delay = temp;
    }
    return <any>setTimeout(fn as Function, delay || 0);
}

interface Env { [key: string] : any; }
export declare type FallbackFn = () => Promise<any>;
export declare type ArgsFn = () => any[];
export declare type InterruptFn = (t:number,fallback:FallbackFn|undefined) => Promise<any>;

export declare type StdoutHandlerFn = (text:string) => boolean;
export declare type StderrHandlerFn = (text:string) => boolean;

interface Logger {
    write:(text:string)=>any;
}

export interface ProcessOptions {
    relaunch?:boolean;
    delay?:number;
    tolerance?:number;
    maxRestarts?:number;

    name?:string;
    logger?:Logger;
    mute?:boolean;
    noWarnings?:boolean;
    verbose?:boolean;

    noInterrupts?:boolean;
    args?:ArgsFn|any[];
    cwd?:string;
    windowsHide?:boolean;
    detached?:boolean;
    env?:Env;

    stdout?:StdoutHandlerFn;
    stderr?:StderrHandlerFn;
    pipe?:boolean;
    splitLines?:boolean;
}

class FlowProcess extends EventEmitter {

    //options:ProcessOptions;

    relaunch:boolean;
    delay:number;
    tolerance:number;
    restarts:number;
    maxRestarts:number;

    name?:string;
    logger?:Logger;
    mute?:boolean;
    noWarnings:boolean;
    verbose?:boolean;

    ts:number;
    kick:boolean;
    restart_dpc?:NodeJS.Timeout;
    process?:ChildProcess;
    args:ArgsFn|any[];
    cwd?:string;
    env?:Env;
    windowsHide:boolean;
    detached:boolean;

    stdout?:StdoutHandlerFn;
    stderr?:StderrHandlerFn;
    pipe:boolean;
    stdin?:NodeJS.Socket;
    splitLines:boolean;

    SIGTERM?:InterruptFn;
    SIGINT?:InterruptFn;
    WAIT_FOR_EXIT?:InterruptFn;

    constructor(options:ProcessOptions) {
        super();

        // this.options = Object.assign({
        //     relaunch : true,
        //     delay : 3000,
        //     tolerance : 5000,
        //     restarts : 0
        // },options);

        this.logger = options.logger;
        this.mute = options.mute || false;
        this.noWarnings = options.noWarnings || false;
        this.verbose = options.verbose;
        this.relaunch = options.relaunch || true;
        this.delay = options.delay ?? 3000;
        this.restarts = 0;
        this.maxRestarts = options.maxRestarts || 0;
        this.tolerance = options.tolerance ?? 5000;
        this.args = options.args||[];
        this.name = options.name;
        this.ts = Date.now();
        this.kick = false;
        this.stdout = options.stdout || undefined;
        this.stderr = options.stderr || undefined;
        this.pipe = options.pipe || false;
        this.splitLines = options.splitLines || false;
        this.windowsHide = options.windowsHide || false;
        this.detached = options.detached || false;

        if(!options.noInterrupts) {
            this.SIGTERM = this.createInterrupt('SIGTERM');
            this.SIGINT = this.createInterrupt('SIGINT');
            this.WAIT_FOR_EXIT = this.createInterrupt(null);
        }
    }

    terminate(interrupt:NodeJS.Signals = 'SIGTERM') {
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

    restart(interrupt:NodeJS.Signals = 'SIGTERM') {
        if(this.process) {
            this.kick = true;
            this.process.kill(interrupt);
        }

        return Promise.resolve();
    }

    createInterrupt(interrupt:NodeJS.Signals|null) {
        return (t:number = 1e4, fallback:FallbackFn|undefined = undefined) => {
            return new Promise((resolve, reject) => {

                if(this.restart_dpc) {
                    clearTimeout(this.restart_dpc);
                    delete this.restart_dpc;
                }

                if(!this.process)
                    return reject('not running');

                const ts = Date.now();
                let success = false;
                const exitHandler = (code:number) => {
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

    run() : Promise<any> {
        return new Promise((resolve, reject) => {
            delete this.restart_dpc;

            let fn_ = (typeof(this.args) == 'function');
            let args = fn_ ? (this.args as ArgsFn)().slice() : (this.args as any[]).slice();

            this.verbose && console.log("running:", args);

            if(this.process) {
                // throw new Error("Process is already running!");
                console.error("Process is already running",this);
                return reject('process is already running');
            }

            let proc = args.shift();
            if(!this.name)
                this.name = proc;
            let cwd = this.cwd || process.cwd();
            let windowsHide = this.windowsHide;
            let detached = this.detached;
            let env = (this.env && Object.keys(this.env).length) ? this.env : undefined;

            //let filter = options.filter || function(data) { return data; };

            let filter_ = (data:any) => { return data; }
            let stdout = (typeof(this.stdout) == 'function') ? this.stdout : filter_;
            let stderr = (typeof(this.stderr) == 'function') ? this.stderr : filter_;

            // console.log(proc, args, { cwd, windowsHide });
            this.emit('start');
            this.process = spawn(proc, args, { cwd, windowsHide, detached, env });
            if(this.process) {
                // Good example here for piping directly to log files: https://nodejs.org/api/child_process.html#child_process_options_detached
                if(this.pipe) {
                    this.process.stdout!.pipe(process.stdout);
                    this.process.stderr!.pipe(process.stderr);
                    this.stdin = process.openStdin();
                    this.stdin.pipe(this.process.stdin!);
                }
                else
                if(this.splitLines) {
                    this.process.stdout!.on('data',(data) => {
                        data.toString('utf8').split('\n').map( (l:string) => console.log(l) );
                        //process.stdout.write(data);
                        if(this.logger)
                            this.logger.write(data);
                    });

                    this.process.stderr!.on('data',(data) => {
                        data.toString('utf8').split('\n').map( (l:string) => console.log(l) );
                        //process.stderr.write(data);
                        if(this.logger)
                            this.logger.write(data);
                    });
                }
                else
                {
                    this.process.stdout!.on('data',(data) => {
                        //console.log(data.toString('utf8'));
                        let text = stdout(data);
                        if(!this.mute && text)
                            process.stdout.write(text);
                        if(this.logger)
                            this.logger.write(data);
                    });

                    this.process.stderr!.on('data',(data) => {
                        //console.error(data.toString('utf8'));
                        let text = stdout(data);
                        if(!this.mute && text)
                            process.stderr.write(text);
                        if(this.logger)
                            this.logger.write(data);
                    });
                }

                this.process.on('exit', (code) => {
                    this.emit('exit',code);
                    let { name } = this;
                    if(code && !this.noWarnings)
                        console.log(`WARNING - child ${name} exited with code ${code}`);
                    delete this.process;
                    let ts = Date.now();
                    if(this.maxRestarts && this.ts && (ts - this.ts) < this.tolerance) {
                        this.restarts++;
                    }
                    if(this.maxRestarts && this.restarts == this.maxRestarts) {
                        this.relaunch = false;
                        console.log(`Too many restarts ${this.restarts}/${this.maxRestarts} ...giving up`);
                    }
                    this.ts = ts;
                    if(this.relaunch) {
                        if(this.maxRestarts && !this.kick)
                            console.log(`Restarting process '${name}': ${this.restarts}/${this.maxRestarts} `);
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

                resolve(this.process);
            }
            else {
                reject('unable to spawn process');
            }
        })
    }
}

module.exports = FlowProcess;