import {Script} from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const validate = new Script<{ value: number }>({
    name: "validate",
    description: "Validate input",
    rollback: 'none'
})
    .addPhase("Validate input", {
        description: "Various input checks"
    })
    .addStep({
        name: "Is Even",
        handler: async ({input, status}) => {
            status('Starting Check')
            await wait(1000)
            return {isEven: input.value % 2 === 0}
        }
    })
    .addStep({
        name: "Is Positive",
        handler: async ({input, status}) => {
            status('Starting Check')
            await wait(1000)
            return {isPositive: input.value >= 0}
        }
    })

const result = await validate.run({
    value: 3
});
console.log(result);
