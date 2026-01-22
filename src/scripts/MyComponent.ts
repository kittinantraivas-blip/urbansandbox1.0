
// 1) Uncomment the code below to get started with your own script!
// 2) You can then return to your editor and add the 'MyComponent' component to any object in your scene.
// 3) Click Export or Play and see the effect in the browser. You've successfully added your first Needle Engine component to your 3D scene
// 4) Continue learning on https://docs.needle.tools/scripting


// import { Behaviour, Gizmos, serializable, showBalloonMessage } from "@needle-tools/engine";
// import { Object3D } from "three";

// export class MyComponent extends Behaviour {

//     @serializable()
//     rotationSpeed: number = 1;

//     @serializable(Object3D)
//     otherObject: Object3D | null = null;

//     start() {
//         showBalloonMessage("Hello Needle");
//         console.log("Hello Needle - this component is on the " + this.gameObject.name + " object");
//     }

//     update(): void {
//         Gizmos.DrawWireSphere(this.gameObject.worldPosition, .5, 0xddff33);
//         if (this.otherObject) this.otherObject.rotateY(this.context.time.deltaTime * this.rotationSpeed);
//         else this.gameObject.rotateY(this.context.time.deltaTime * this.rotationSpeed);
//     }

// }