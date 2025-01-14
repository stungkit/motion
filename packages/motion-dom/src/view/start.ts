import { secondsToMilliseconds } from "motion-utils"
import { BaseGroupPlaybackControls } from "../animation/controls/BaseGroup"
import { AnimationPlaybackControlsWithFinished } from "../animation/types"
import { getValueTransition } from "../animation/utils/get-value-transition"
import { NativeAnimationControls } from "../animation/waapi/NativeAnimationControls"
import { PseudoAnimation } from "../animation/waapi/PseudoAnimation"
import { applyGeneratorOptions } from "../animation/waapi/utils/convert-options"
import { mapEasingToNativeEasing } from "../animation/waapi/utils/easing"
import { Target, ViewTransitionOptions, ViewTransitionTarget } from "./types"
import { chooseLayerType } from "./utils/choose-layer-type"
import { css } from "./utils/css"
import { getLayerName } from "./utils/get-layer-name"
import { getViewAnimations } from "./utils/get-view-animations"
import { hasTarget } from "./utils/has-target"

const definitionNames = ["layout", "enter", "exit", "new", "old"] as const

export function startViewAnimation(
    update: () => void | Promise<void>,
    defaultOptions: ViewTransitionOptions,
    targets: Map<Target, ViewTransitionTarget>
): Promise<BaseGroupPlaybackControls> {
    if (!document.startViewTransition) {
        return new Promise(async (resolve) => {
            await update()
            resolve(new BaseGroupPlaybackControls([]))
        })
    }

    // TODO: Go over existing targets and ensure they all have ids

    /**
     * If we don't have any animations defined for the root target,
     * remove it from being captured.
     */
    if (!hasTarget("root", targets)) {
        css.set(":root", {
            "view-transition-name": "none",
        })
    }

    /**
     * Set the timing curve to linear for all view transition layers.
     * This gets baked into the keyframes, which can't be changed
     * without breaking the generated animation.
     *
     * This allows us to set easing via updateTiming - which can be changed.
     */
    css.set(
        "::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*)",
        { "animation-timing-function": "linear !important" }
    )

    css.commit() // Write

    const transition = document.startViewTransition(async () => {
        await update()

        // TODO: Go over new targets and ensure they all have ids
    })

    transition.finished.finally(() => {
        css.remove() // Write
    })

    return new Promise((resolve) => {
        transition.ready.then(() => {
            const generatedViewAnimations = getViewAnimations()

            const animations: AnimationPlaybackControlsWithFinished[] = []

            /**
             * Create animations for our definitions
             */
            targets.forEach((definition, target) => {
                // TODO: If target is not "root", resolve elements
                // and iterate over each

                for (const key of definitionNames) {
                    if (!definition[key]) continue
                    const { keyframes, options } =
                        definition[key as keyof ViewTransitionTarget]!

                    for (let [valueName, valueKeyframes] of Object.entries(
                        keyframes
                    )) {
                        if (!valueKeyframes) continue

                        const valueOptions = {
                            ...getValueTransition(
                                defaultOptions as any,
                                valueName
                            ),
                            ...getValueTransition(options as any, valueName),
                        }

                        const type = chooseLayerType(
                            key as keyof ViewTransitionTarget
                        )

                        /**
                         * If this is an opacity animation, and keyframes are not an array,
                         * we need to convert them into an array and set an initial value.
                         */
                        if (
                            valueName === "opacity" &&
                            !Array.isArray(valueKeyframes)
                        ) {
                            const initialValue = type === "new" ? 0 : 1
                            valueKeyframes = [initialValue, valueKeyframes]
                        }

                        /**
                         * Resolve stagger function if provided.
                         */
                        if (typeof valueOptions.delay === "function") {
                            valueOptions.delay = valueOptions.delay(0, 1)
                        }

                        const animation = new PseudoAnimation(
                            document.documentElement,
                            `::view-transition-${type}(${target})`,
                            valueName,
                            valueKeyframes,
                            valueOptions
                        )

                        animations.push(animation)
                    }
                }
            })

            /**
             * Handle browser generated animations
             */
            for (const animation of generatedViewAnimations) {
                if (animation.playState === "finished") continue

                const { effect } = animation
                if (!effect || !(effect instanceof KeyframeEffect)) continue

                const { pseudoElement } = effect
                if (!pseudoElement) continue

                const name = getLayerName(pseudoElement)
                if (!name) continue

                const targetDefinition = targets.get(name.layer)

                if (!targetDefinition) {
                    /**
                     * If transition name is group then update the timing of the animation
                     * whereas if it's old or new then we could possibly replace it using
                     * the above method.
                     */
                    const transitionName = name.type === "group" ? "layout" : ""
                    const animationTransition = {
                        ...getValueTransition(defaultOptions, transitionName),
                    }

                    applyGeneratorOptions(animationTransition)

                    const easing = mapEasingToNativeEasing(
                        animationTransition.ease,
                        animationTransition.duration!
                    ) as string

                    effect.updateTiming({
                        delay: secondsToMilliseconds(
                            animationTransition.delay ?? 0
                        ),
                        duration: animationTransition.duration,
                        easing,
                    })

                    animations.push(new NativeAnimationControls(animation))
                } else if (
                    hasOpacity(targetDefinition, "enter") &&
                    hasOpacity(targetDefinition, "exit") &&
                    effect
                        .getKeyframes()
                        .some((keyframe) => keyframe.mixBlendMode)
                ) {
                    animations.push(new NativeAnimationControls(animation))
                } else {
                    animation.cancel()
                }
            }

            resolve(new BaseGroupPlaybackControls(animations))
        })
    })
}

function hasOpacity(
    target: ViewTransitionTarget | undefined,
    key: "enter" | "exit" | "layout"
) {
    return target?.[key]?.keyframes.opacity
}