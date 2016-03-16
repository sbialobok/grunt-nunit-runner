var fs = require('fs'),
    path = require('path'),
    _ = require('underscore'),
    msbuild = require('./msbuild.js'),
    sax = require('sax');

var versionExec = {
    "2.x": {
       'x86': 'nunit-console-x86.exe',
       'x64': 'nunit-console.exe'
   },
   "3.x": {
       'x86': 'nunit3-console.exe',
       'x64': 'nunit3-console.exe'
    }
}
var versionCommand = {
   "2.x": function(cmd, val) {
       return this[cmd].apply(this,val);
   },
   "3.x": function(cmd, val) {
       if(this[cmd] !== undefined)
        return this[cmd].apply(this, val);
       return version['2.x'](cmd, val).replace('/', '--').replace(':','=');
   }
};
versionCommand['2.x'].run = function (val) { return '/run:"' + val.join(',') + '"'; }
versionCommand['2.x'].runlist = function(val) { return '/runlist:"' + val + '"'};
versionCommand['2.x'].config = function(val) { return '/config:"' + val + '"'};
versionCommand['2.x'].result = function(val) { return '/result:"' + val + '"'};
versionCommand['2.x'].noresult = function(val) { return '/noresult'};
versionCommand['2.x'].output = function(val) { return '/output:"' + val + '"'};
versionCommand['2.x'].err = function(val) { return '/err:"' + val + '"'};
versionCommand['2.x'].work = function(val) { return '/work:"' + val + '"'};
versionCommand['2.x'].labels = function(val) { return '/labels'};
versionCommand['2.x'].trace = function(val) { return '/trace:' + val};
versionCommand['2.x'].include = function(val) { return val.length > 0 ? '/include:"' + val.join(',') + '"' : ''};
versionCommand['2.x'].exclude = function(val) { return val.length > 0 ? '/exclude:"' + val.join(',') + '"' : ''};
versionCommand['2.x'].framework = function(val) { return '/framework:"' + val + '"'};
versionCommand['2.x'].process = function(val) { return '/process:' + val};
versionCommand['2.x'].domain = function(val) { return '/domain:' + val};
versionCommand['2.x'].apartment = function(val) { return '/apartment:' + val};
versionCommand['2.x'].noshadow = function(val) { return '/noshadow'};
versionCommand['2.x'].nothread = function(val) { return '/nothread'};
versionCommand['2.x'].basepath = function(val) { return '/basepath:"' + val + '"'};
versionCommand['2.x'].privatebinpath = function(val) { return val.length > 0 ? '/privatebinpath:"' + val.join(';') + '"' : ''};
versionCommand['2.x'].timeout = function(val) { return '/timeout:' + val};
versionCommand['2.x'].wait = function(val) { return '/wait'};
versionCommand['2.x'].nologo = function(val) { return '/nologo'};
versionCommand['2.x'].nodots = function(val) { return '/nodots'};
versionCommand['2.x'].stoponerror = function(val) { return '/stoponerror'};
versionCommand['2.x'].cleanup = function(val) { return '/cleanup'};

exports.findTestAssemblies = function(files, options) {
    var assemblies = [];
    var projects = [];
    files.forEach(function(file) {
        switch(path.extname(file)) {
            case '.sln': projects = projects.concat(msbuild.getSolutionProjectInfo(file)); break;
            case '.csproj': projects.push(msbuild.getProjectInfo(file)); break;
            default: {
                if (!fs.existsSync(file)) throw new Error('Assembly not found: ' + file);
                assemblies.push(path.normalize(file));
            }
        }
    });
    projects.
        filter(function(project) { return _.contains(project.references, 'nunit.framework'); }).
        forEach(function(project) {
            var outputs = project.output.filter(function(output) { return fs.existsSync(output); });
            if (outputs.length === 0) throw new Error('No assemblies exist for project: ' + project.path);
            
            if (options && options.config) {
                outputs = outputs.filter(function(output) { 
                    return output.toLowerCase().indexOf(options.config.toLowerCase()) > -1; 
                });
            }

            if (outputs.length === 0) throw new Error('No assemblies exist for project matching config parameter: ' + project.path);
            assemblies.push(path.normalize(outputs[0]));
        });
    return assemblies;
};

exports.buildCommand = function(assemblies, options) {
    var platform = options.platform || 'x64';
    var version = options.version || '3.x';
    var nunit = versionExec[version][platform];
    
    if (options.path) nunit = path.join(options.path, nunit);

    nunit = nunit.replace(/\\/g, path.sep);

    var args = assemblies.map(function(assembly) { return '"' + assembly + '"'; });
    if(version === '3.x') {
        args.push('--result=TestResults.xml;format=nunit2');
    }
    for(var o in options) {
        if(versionCommand[version][o] !== undefined) {
            args.push(versionCommand[version](o, options[o]));
        }
    }

    return {
        path: nunit,
        args: args
    };
};

exports.createTeamcityLog = function(results) {

    var parser = sax.parser(true);
    var log = [];
    var ancestors = [];
    var message, stackTrace;

    var getSuiteName = function(node) { return node.attributes.type === 'Assembly' ? 
        path.basename(node.attributes.name.replace(/\\/g, path.sep)) : node.attributes.name; };

    parser.onopentag = function (node) {
        ancestors.push(node);
        switch (node.name) {
            case 'test-suite': log.push('##teamcity[testSuiteStarted name=\'' + getSuiteName(node) + '\']'); break;
            case 'test-case': 
                if (node.attributes.executed === 'True') log.push('##teamcity[testStarted name=\'' + node.attributes.name + '\']'); 
                message = '';
                stackTrace = '';
                break; 
        }
    };

    parser.oncdata = function (data) {
        data = data.
            replace(/\|/g, '||').
            replace(/\'/g, '|\'').
            replace(/\n/g, '|n').
            replace(/\r/g, '|r').
            replace(/\u0085/g, '|x').
            replace(/\u2028/g, '|l').
            replace(/\u2029/g, '|p').
            replace(/\[/g, '|[').
            replace(/\]/g, '|]');

        switch (_.last(ancestors).name) {
            case 'message': message += data; break;
            case 'stack-trace': stackTrace += data; break;
        }
    };

    parser.onclosetag = function (node) {
        node = ancestors.pop();
        switch (node.name) {
            case 'test-suite': log.push('##teamcity[testSuiteFinished name=\'' + getSuiteName(node) + '\']'); break;
            case 'test-case': 
                if (node.attributes.result === 'Ignored')
                    log.push('##teamcity[testIgnored name=\'' + node.attributes.name + '\'' + 
                        (message ? ' message=\'' + message + '\'' : '') + ']'); 
                else if (node.attributes.executed === 'True') {
                    if (node.attributes.success === 'False') {
                        log.push('##teamcity[testFailed name=\'' + node.attributes.name + '\'' +
                            (message ? ' message=\'' + message + '\'' : '') + 
                            (stackTrace ? ' details=\'' + stackTrace + '\'' : '') + ']');
                    }
                    var duration = node.attributes.time ? ' duration=\'' + parseInt(
                        node.attributes.time.replace(/[\.\:]/g, '')) + '\'' : '';
                    log.push('##teamcity[testFinished name=\'' + node.attributes.name + '\'' + duration + ']');
                }
                break;
        }
    };

    parser.write(fs.readFileSync(results, 'utf8')).close();

    return log;
};