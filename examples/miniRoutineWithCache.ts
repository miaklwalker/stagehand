import { fileStore, routineFor, Script } from "../dist/index.js";




const cache = fileStore('./test-cache');
const myRoutine = routineFor<{}>()(
    'My Routine',
    script => script
    .addPhase('Phase One',{ cache })
        .addStep({
            name: 'Pull The lever',
            handler: async () => {
                return { lever: 'Not Pulled' }
            }
        })
        .addStep({
            name: 'Humorous Quip',
            handler: async (context) => {
                context.warn('NOT THAT LEVER KRONK!')
            }
        })
)


const myScript = new Script<{ name: string}>({
    name: "MyScript.js",
    description: 'do it '
})
    .addPhase('Start')
    .addStep({
        name: 'Cache Test',
        cache,
        handler: async () => {
            return { worldPeace: 'yes'}
        }
    })
    .use(myRoutine)
    .addPhase('Clean up',{ cache })
    .addStep({
        name: 'find kuzco',
        cache,
        handler: async (context) => {
            return{ notFound: true }
        }
    })
    .addPhase('Panic')
    .addStep({
        name: 'clear cache',
        handler: async (context) => {
            const foo = await context.cache.read('Start::Cache Test');
        }
    })

