import {Script} from "../dist/index.js";


const script = new Script({})
    .addStep({
        name: 'build results',
        handler: async () => {
            return {results: [{name: 'fancy!'}]}
        }
    })
    .addStep({
        name: 'use results',
        when: (context) => context.ctx.results.length > 0,
        rollbackKeys:['results'],
        handler: async ({ ctx }) => {
            for(let res of ctx.results) {
                console.log(res);
            }
        },
        rollback: async ({ ctx }) => {
            console.log(ctx.results);
        },
    });

script.outline()
