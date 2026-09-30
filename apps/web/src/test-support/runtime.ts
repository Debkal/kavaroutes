import {makeBoardProjection} from "./fixtures";
import {createProjectionStore} from "./projection-store";
import {createSyntheticApi} from "./synthetic-api";
export const projectionStore=createProjectionStore(makeBoardProjection());
export const syntheticApi=createSyntheticApi(projectionStore.getSnapshot());
