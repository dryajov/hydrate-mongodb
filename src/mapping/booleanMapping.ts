import {MappingBase} from "./mappingBase";
import {MappingModel} from "./mappingModel";
import {ReadContext} from "./readContext";
import {WriteContext} from "./writeContext";

/**
 * @hidden
 */
export class BooleanMapping extends MappingBase {

    constructor() {
        super(MappingModel.MappingFlags.Boolean);
    }

    read(context: ReadContext, value: any): any {

        if(value == null) return null;

        if(typeof value !== "boolean") {
            context.addError("Expected boolean.");
            return;
        }
        return value;
    }

    write(context: WriteContext, value: any): any {

        if(value == null) return null;

        if(typeof value !== "boolean") {
            context.addError("Expected boolean.");
            return;
        }
        return value;
    }
}
