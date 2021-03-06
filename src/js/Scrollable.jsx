import { AnimationTimer } from 'animation-timer';
import classnames from 'classnames';
import { Easer } from 'functional-easing';
import React, { PropTypes as types } from 'react';
import _ from 'lodash';

import * as constants from './constants';
import * as customTypes from './propTypes';
import LightweightRow from './LightweightRow';
import { Point } from './models';
import Row from './Row';
import {
  buildRowConfig,
  getGutterWidths,
  getMaxHeight,
  getResizeValues,
  getVelocityInfo,
  getVerticalScrollValues,
  returnWidthIfComponentExists
} from './utils';

const easer = new Easer()
  .using('out-cubic');

export default class Scrollable extends React.Component {
  constructor(props) {
    super(props);
    [
      '_applyScrollChange',
      '_getBottomGutterHeight',
      '_getContentWidth',
      '_getDimensions',
      '_getThrottledHorizontalAnimationFrameFn',
      '_getThrottledVerticalAnimationFrameFn',
      '_getTopGutterHeight',
      '_getWeightedWidth',
      '_onHorizontalScroll',
      '_onResize',
      '_onMouseWheel',
      '_onVerticalScroll',
      '_renderContents',
      '_renderCorner',
      '_renderHorizontalScrollbar',
      '_renderHeader',
      '_renderVerticalScrollbar',
      '_shouldRenderScrollbars',
      '_startResize',
      '_stopResize',
      '_switchScrollProp',
      'scrollRowToMiddle',
      'scrollToHeader',
      'toggleSection'
    ].forEach(method => { this[method] = this[method].bind(this); });
    this._debouncedStartHorizontalScroll = _.debounce(this._startHorizontalScroll, 100);
    this._endScroll = _.debounce(() => this.setState({
      isFastScrolling: false,
      isScrolling: false,
      velocityQueue: [[0, 0]]
    }), 50, { trailing: true });
    this._endVerticalScroll = _.debounce(() => this.setState({
      isFastScrolling: false,
      isScrolling: false,
      velocityQueue: [[0, 0]]
    }), 200, { trailing: true });
    this._onThrottledMouseWheel = _.throttle(this._applyScrollChange, constants.ANIMATION_FPS_120, { trailing: true });
    const {
      headerType = constants.headerType.DEFAULT,
      height,
      list,
      lists,
      width
    } = props;
    const stackingHeaders = headerType === constants.headerType.STACKING;
    const listContainer = list || lists;
    const {
      avgRowHeight,
      collapsedSections,
      contentHeight,
      headers,
      partitions,
      rowOffsets,
      rows
    } = buildRowConfig(listContainer, stackingHeaders);
    const {
      displayBuffer,
      shouldRender
    } = this._getDimensions(avgRowHeight, contentHeight, height, width);

    this.state = {
      animation: null,
      avgRowHeight,
      collapsedSections,
      contentHeight,
      displayBuffer,
      isFastScrolling: false,
      headers,
      horizontalTransform: 0,
      partitions,
      resize: {
        basePosition: 0,
        currentPosition: 0,
        performing: false,
        side: '',
        startingPosition: 0
      },
      rowOffsets,
      rows,
      isScrolling: false,
      scrollingToPosition: new Point(0, 0),
      shouldRender,
      topPartitionIndex: 0,
      velocityQueue: [[0, 0]],
      verticalTransform: 0
    };
  }

  componentDidMount() {
    const {
      scrollTo: scrollToWithoutDefaults
    } = this.props;

    if (!scrollToWithoutDefaults) {
      return;
    }

    this._switchScrollProp(_.merge(
      _.cloneDeep(constants.defaultScrollTo),
      _.cloneDeep(scrollToWithoutDefaults)
    ));
  }

  componentWillReceiveProps({
    guttersConfig,
    headerType = constants.headerType.DEFAULT,
    height,
    horizontalScrollConfig,
    list: nextList,
    lists: nextLists,
    scrollTo: scrollToWithoutDefaults = {},
    verticalScrollConfig,
    width
  }) {
    const {
      props: {
        guttersConfig: prevGuttersConfig,
        height: prevHeight,
        horizontalScrollConfig: prevHorizontalScrollConfig,
        list: prevList,
        lists: prevLists,
        scrollTo: prevScrollToWithoutDefaults = {},
        verticalScrollConfig: prevVerticalScrollConfig,
        width: prevWidth
      },
      state: {
        avgRowHeight: prevAvgRowHeight,
        collapsedSections: oldCollapsedSections,
        contentHeight: prevContentHeight
      }
    } = this;

    const stackingHeaders = headerType === constants.headerType.STACKING;
    const prevListContainer = prevList || prevLists;
    const nextListContainer = nextList || nextLists;

    if (prevListContainer !== nextListContainer || !_.isEqual(prevListContainer, nextListContainer)) {
      const {
        avgRowHeight,
        collapsedSections,
        contentHeight,
        headers,
        partitions,
        rowOffsets,
        rows
      } = buildRowConfig(nextListContainer, stackingHeaders, oldCollapsedSections);
      this.setState({
        avgRowHeight,
        collapsedSections,
        contentHeight,
        headers,
        partitions,
        rowOffsets,
        rows,
        ...this._getDimensions(avgRowHeight, contentHeight, height, width)
      });
    } else if (
      height !== prevHeight
      || width !== prevWidth
      || !_.isEqual(prevGuttersConfig, guttersConfig)
      || !_.isEqual(prevHorizontalScrollConfig, horizontalScrollConfig)
      || !_.isEqual(prevVerticalScrollConfig, verticalScrollConfig)
    ) {
      this.setState(this._getDimensions(prevAvgRowHeight, prevContentHeight, height, width));
    }

    const prevScrollTo = _.merge(
      _.cloneDeep(constants.defaultScrollTo),
      _.cloneDeep(prevScrollToWithoutDefaults)
    );
    const scrollTo = _.merge(
      _.cloneDeep(constants.defaultScrollTo),
      _.cloneDeep(scrollToWithoutDefaults)
    );

    if (!_.isEqual(prevScrollTo, scrollTo)) {
      this._switchScrollProp(scrollTo);
    }
  }

  shouldComponentUpdate(nextProps, nextState) {
    return this.state.verticalTransform !== nextState.verticalTransform
      || this.state.horizontalTransform !== nextState.horizontalTransform
      || this.props.height !== nextProps.height
      || this.props.width !== nextProps.width
      || !_.isEqual(this.props, nextProps)
      || !_.isEqual(this.state, nextState);
  }

  // private

  _applyScrollChange({ deltaX: _deltaX, deltaY: _deltaY }) {
    const {
      props: {
        disableBidirectionalScrolling = false,
        height,
        horizontalScrollConfig,
        horizontalScrollConfig: {
          onScroll: onHorizontalScroll = () => {}
        } = {},
        verticalScrollConfig: {
          onScroll: onVerticalScroll = () => {}
        } = {}
      },
      state: {
        contentHeight,
        isFastScrolling: oldFastScrollTrip,
        partitions,
        shouldRender,
        velocityQueue: oldVelocityQueue
      },
      _horizontalScrollbar,
      _verticalScrollbar
    } = this;
    const withHorizontalScrolling = !!horizontalScrollConfig && shouldRender.horizontalScrollbar;

    let deltaX = _deltaX;
    let deltaY = _deltaY;

    if (disableBidirectionalScrolling) {
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        deltaY = 0;
      } else {
        deltaX = 0;
      }
    }

    const scrollChanges = {
      isScrolling: true
    };

    // vertical
    if (shouldRender.verticalScrollbar) {
      const maxHeight = getMaxHeight(contentHeight, _verticalScrollbar.offsetHeight);
      const verticalTransform = this.state.verticalTransform + deltaY;
      const { averageVelocity, velocityQueue } = getVelocityInfo(deltaY, oldVelocityQueue);

      const isFastScrolling = oldFastScrollTrip
        || Math.abs(averageVelocity) > (height * constants.USER_INITIATED_FAST_SCROLL_FACTOR);

      _.assign(
        scrollChanges,
        getVerticalScrollValues(verticalTransform, maxHeight, partitions),
        { isFastScrolling, velocityQueue }
      );
    }

    // horizontal scrolling
    if (withHorizontalScrolling) {
      scrollChanges.horizontalTransform = _.clamp(
        this.state.horizontalTransform + deltaX,
        0,
        _horizontalScrollbar.scrollWidth - _horizontalScrollbar.offsetWidth
      );
    }

    this.setState(scrollChanges, () => {
      if (shouldRender.verticalScrollbar) {
        if (_verticalScrollbar.scrollTop !== scrollChanges.verticalTransform) {
          onVerticalScroll(scrollChanges.verticalTransform);
        }
        _verticalScrollbar.scrollTop = scrollChanges.verticalTransform;
      }

      if (withHorizontalScrolling) {
        if (_horizontalScrollbar.scrollLeft !== scrollChanges.horizontalTransform) {
          onHorizontalScroll(scrollChanges.horizontalTransform);
        }
        _horizontalScrollbar.scrollLeft = scrollChanges.horizontalTransform;
      }

      this._endScroll();
    });
  }

  _getBottomGutterHeight() {
    const {
      props: {
        height,
        headerType = constants.headerType.DEFAULT,
        horizontalScrollConfig: {
          scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
        } = {}
      },
      state: {
        headers,
        shouldRender,
        verticalTransform
      }
    } = this;

    if (headerType !== constants.headerType.STACKING) {
      return 0;
    }

    const adjustedHeight = shouldRender.horizontalScrollbar
      ? height - scrollbarHeight
      : height;

    let slidingWindowOfGutterHeight = 0;
    const indexOfFirstFreeGutter = headers.length - _.findIndex(
      _.reverse(_.clone(headers)),
      ({ height: headerHeight, realOffset }) => {
        const adjustedTransform = (verticalTransform + adjustedHeight) - slidingWindowOfGutterHeight;
        const gutterIsLocked = adjustedTransform < realOffset;
        if (gutterIsLocked) {
          slidingWindowOfGutterHeight = headerHeight;
        }
        return !gutterIsLocked;
      }
    );

    return _(headers)
      .slice(indexOfFirstFreeGutter)
      .reduce((prevHeight, { height: headerHeight }) => prevHeight + headerHeight, 0);
  }

  _getTopGutterHeight() {
    const {
      props: {
        headerType = constants.headerType.DEFAULT
      },
      state: {
        headers,
        verticalTransform
      }
    } = this;

    if (headerType === constants.headerType.DEFAULT) {
      return 0;
    }

    const findNextHeaderIndex = _.findIndex(headers, ({ lockPosition }) => lockPosition > verticalTransform);
    const nextHeaderIndex = findNextHeaderIndex === -1
      ? headers.length
      : findNextHeaderIndex;

    if (headerType === constants.headerType.LOCKING) {
      const header = headers[nextHeaderIndex - 1];
      return header.height;
    }

    return _(headers)
      .slice(0, nextHeaderIndex)
      .reduce((prevHeight, { height }) => prevHeight + height, 0);
  }

  _getContentWidth() {
    const {
      props: {
        dynamicColumn = constants.columns.MIDDLE,
        guttersConfig,
        guttersConfig: {
          left,
          left: {
            handleWidth: leftHandleWidth = constants.LEFT_HANDLE_WIDTH,
            position: leftGutterPosition = 0
          } = {},
          right,
          right: {
            handleWidth: rightHandleWidth = constants.RIGHT_HANDLE_WIDTH,
            position: rightGutterPosition = 0
          } = {}
        } = {},
        horizontalScrollConfig: {
          contentWidth = 0
        } = {},
        width
      }
    } = this;

    let leftGutterWidth;
    let rightGutterWidth;
    switch (guttersConfig ? dynamicColumn : constants.columns.MIDDLE) {
      case constants.columns.LEFT:
        leftGutterWidth = width - leftGutterPosition - leftHandleWidth;
        rightGutterWidth = rightGutterPosition;
        break;
      case constants.columns.RIGHT:
        leftGutterWidth = leftGutterPosition;
        rightGutterWidth = width - rightGutterPosition - rightHandleWidth;
        break;
      default:
        leftGutterWidth = leftGutterPosition;
        rightGutterWidth = rightGutterPosition;
    }

    return _.sum([
      contentWidth,
      leftGutterWidth,
      left ? leftHandleWidth : 0,
      right ? rightHandleWidth : 0,
      rightGutterWidth
    ]);
  }

  _getDimensions(avgRowHeight, contentHeight, height, width) {
    const {
      scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
    } = this.props.horizontalScrollConfig || {};
    const shouldRender = this._shouldRenderScrollbars(contentHeight, height, width);
    const contentsDivHeight = height - (shouldRender.horizontalScrollbar ? scrollbarHeight : 0);
    const numRowsInContents = _.ceil(contentsDivHeight / avgRowHeight);

    let displayBuffer = numRowsInContents + (2 * constants.OFFSET_BUFFER);
    displayBuffer += constants.OFFSET_BUFFER - (displayBuffer % constants.OFFSET_BUFFER);

    const newState = {
      displayBuffer,
      shouldRender
    };

    if (!shouldRender.verticalScrollbar) {
      newState.verticalTransform = 0;
      newState.topPartitionIndex = 0;
      if (this._verticalScrollbar) {
        this._verticalScrollbar.scrollTop = 0;
      }
    }

    if (!shouldRender.horizontalScrollbar) {
      newState.horizontalTransform = 0;
      if (this._horizontalScrollbar) {
        this._horizontalScrollbar.scrollLeft = 0;
      }
    }

    return newState;
  }

  _getThrottledHorizontalAnimationFrameFn(scrollTo) {
    const {
      props: {
        horizontalScrollConfig: {
          onScroll: onHorizontalScroll = () => {}
        } = {}
      },
      state: {
        horizontalTransform,
        verticalTransform
      }
    } = this;

    const delta = new Point(scrollTo.x, 0)
      .sub(new Point(horizontalTransform, 0));

    this.setState({
      scrolling: true
    });

    return _.throttle(easer(easedElapsedTime => {
      const {
        props: {
          horizontalScrollConfig
        },
        state: {
          scrollingToPosition: latestScrollingToPosition,
          shouldRender
        },
        _horizontalScrollbar
      } = this;
      if (!_.isEqual(scrollTo, latestScrollingToPosition)) {
        return;
      }

      const withHorizontalScrolling = !!horizontalScrollConfig && shouldRender.horizontalScrollbar;
      const elapsedTime = easedElapsedTime > 0.999 ? 1 : easedElapsedTime;
      const deltaScrolled = new Point(delta.x, delta.y)
        .scale(elapsedTime);
      const newTransform = new Point(horizontalTransform, verticalTransform)
        .add(deltaScrolled);

      const scrollChanges = {
        isScrolling: true
      };

      if (withHorizontalScrolling) {
        scrollChanges.horizontalTransform = _.clamp(
          newTransform.x,
          0,
          _horizontalScrollbar.scrollWidth - _horizontalScrollbar.offsetWidth
        );
      }

      this.setState(scrollChanges, () => {
        if (withHorizontalScrolling) {
          if (_horizontalScrollbar.scrollLeft !== scrollChanges.horizontalTransform) {
            onHorizontalScroll(scrollChanges.horizontalTransform);
          }
          _horizontalScrollbar.scrollLeft = scrollChanges.horizontalTransform;
        }

        this._endScroll();
      });
    }), constants.ANIMATION_FPS_120, { leading: true });
  }

  _getThrottledVerticalAnimationFrameFn(scrollTo) {
    const {
      props: {
        height,
        verticalScrollConfig: {
          onScroll: onVerticalScroll = () => {}
        } = {}
      },
      state: {
        horizontalTransform,
        verticalTransform
      }
    } = this;
    const delta = new Point(0, scrollTo.y)
      .sub(new Point(0, verticalTransform));

    const initStateUpdate = {
      scrolling: true
    };

    if (Math.abs(delta.y) > height * constants.SCROLL_TO_FAST_SCROLL_FACTOR) {
      initStateUpdate.isFastScrolling = true;
    }

    this.setState(initStateUpdate);

    return _.throttle(easer(easedElapsedTime => {
      const {
        state: {
          contentHeight,
          partitions,
          scrollingToPosition: latestScrollingToPosition,
          shouldRender
        },
        _verticalScrollbar
      } = this;
      if (!_.isEqual(scrollTo, latestScrollingToPosition)) {
        return;
      }

      const elapsedTime = easedElapsedTime > 0.999 ? 1 : easedElapsedTime;
      const deltaScrolled = new Point(delta.x, delta.y)
        .scale(elapsedTime);
      const newTransform = new Point(horizontalTransform, verticalTransform)
        .add(deltaScrolled);

      const scrollChanges = {
        isScrolling: true
      };

      if (shouldRender.verticalScrollbar) {
        const maxHeight = getMaxHeight(contentHeight, _verticalScrollbar.offsetHeight);
        _.assign(scrollChanges, getVerticalScrollValues(newTransform.y, maxHeight, partitions));
      }

      this.setState(scrollChanges, () => {
        if (shouldRender.verticalScrollbar) {
          if (_verticalScrollbar.scrollTop !== scrollChanges.verticalTransform) {
            onVerticalScroll(scrollChanges.verticalTransform);
          }
          _verticalScrollbar.scrollTop = scrollChanges.verticalTransform;
        }

        this._endScroll();
      });
    }), constants.ANIMATION_FPS_120, { leading: true });
  }

  _getWeightedWidth() {
    const {
      props: {
        verticalScrollConfig: {
          scrollbarWidth = constants.VERTICAL_SCROLLBAR_WIDTH
        } = {},
        width
      },
      state: { shouldRender }
    } = this;

    return width - (shouldRender.verticalScrollbar ? scrollbarWidth : 0);
  }

  _onHorizontalScroll() {
    const {
      props: {
        horizontalScrollConfig: {
          onScroll = () => {}
        } = {}
      },
      state: {
        horizontalTransform
      },
      _horizontalScrollbar
    } = this;

    if (!_horizontalScrollbar || _horizontalScrollbar.scrollLeft === horizontalTransform) {
      return;
    }

    const { scrollLeft = 0 } = _horizontalScrollbar || {};
    this.setState({ horizontalTransform: scrollLeft });
    onScroll(scrollLeft);
  }

  _onMouseWheel({ deltaX, deltaY }) {
    this._onThrottledMouseWheel({ deltaX, deltaY });
  }

  /**
   * Performs a calculation to determine the size difference between each movement of the mouse cursor. Only occurs when
   * a resize is active. Will call the onResize handler for the gutter that is being resized with the new width of the
   * gutter.
   * @param  {number} clientX the position of the mouse cursor horizontally
   */
  _onResize({ clientX }) {
    const { basePosition, performing, side, startingPosition } = this.state.resize;
    const width = this._getWeightedWidth();
    const {
      dynamicColumn = constants.columns.MIDDLE,
      guttersConfig,
      guttersConfig: {
        left,
        left: {
          handleWidth: leftHandleWidth = constants.LEFT_HANDLE_WIDTH,
          position: leftHandlePosition
        } = {},
        right,
        right: {
          handleWidth: rightHandleWidth = constants.RIGHT_HANDLE_WIDTH,
          position: rightHandlePosition
        } = {},
        [side]: {
          minPosition = 0,
          maxPosition = width,
          onResize = (() => {})
        } = {}
      } = {}
    } = this.props;
    if (performing) {
      const deltaPosition = startingPosition - clientX;
      const { max, min, mod } = getResizeValues({
        dynamicColumn: guttersConfig
          ? dynamicColumn
          : constants.columns.MIDDLE,
        leftExists: Boolean(left),
        leftHandlePosition,
        leftHandleWidth,
        rightExists: Boolean(right),
        rightHandlePosition,
        rightHandleWidth,
        side,
        width
      });

      onResize(_.clamp(
        basePosition + (mod * deltaPosition),
        Math.max(minPosition, min),
        Math.min(maxPosition, max)
      ));
    }
  }

  _onVerticalScroll() {
    const {
      props: {
        height,
        verticalScrollConfig: {
          onScroll = () => {}
        } = {}
      },
      state: {
        contentHeight,
        isFastScrolling: wasFastScrolling,
        partitions,
        velocityQueue: oldVelocityQueue,
        verticalTransform
      },
      _verticalScrollbar,
      _verticalScrollbar: {
        offsetHeight,
        scrollTop
      } = {}
    } = this;

    if (!_verticalScrollbar || scrollTop === verticalTransform) {
      return;
    }

    const maxHeight = getMaxHeight(contentHeight, offsetHeight);

    const nextScrollState = getVerticalScrollValues(scrollTop, maxHeight, partitions);
    const {
      averageVelocity,
      velocityQueue
    } = getVelocityInfo(nextScrollState.verticalTransform - verticalTransform, oldVelocityQueue);
    const isFastScrolling = wasFastScrolling || Math.abs(averageVelocity) > (height * 3) / 4;

    this.setState(_.assign(
      nextScrollState,
      {
        averageVelocity,
        isFastScrolling,
        isScrolling: true,
        velocityQueue
      }
    ), () => this._endScroll());
    onScroll(nextScrollState.verticalTransform);
  }

  _renderContents() {
    const {
      props: {
        dynamicColumn = constants.columns.MIDDLE,
        guttersConfig,
        horizontalScrollConfig,
        horizontalScrollConfig: {
          passthroughOffsets = false
        } = {},
        light = false,
        verticalScrollConfig: {
          scrollbarWidth = constants.VERTICAL_SCROLLBAR_WIDTH
        } = {}
      },
      state: {
        displayBuffer,
        isFastScrolling,
        horizontalTransform,
        partitions,
        rows,
        isScrolling,
        shouldRender,
        topPartitionIndex,
        verticalTransform
      }
    } = this;

    const contentsStyle = shouldRender.verticalScrollbar ? {
      width: `calc(100% - ${scrollbarWidth}px)`
    } : undefined;

    const weightedPartitionIndex = topPartitionIndex * constants.OFFSET_BUFFER;
    const startingRowIndex = Math.min(weightedPartitionIndex, rows.length);
    const endingRowIndex = weightedPartitionIndex + displayBuffer;
    const weightedWidth = this._getWeightedWidth();

    const rowsWeWillRender = _.slice(rows, startingRowIndex, endingRowIndex);
    const partitionedRows = _.chunk(rowsWeWillRender, constants.OFFSET_BUFFER);
    const renderedPartitions = _.map(partitionedRows, (row, outerIndex) => {
      const partitionIndex = outerIndex + topPartitionIndex;
      const basePartitionOffset = partitions[partitionIndex];
      const partitionStyle = {
        transform: `translate3d(-0px, ${basePartitionOffset - verticalTransform}px, 0px)`
      };

      return (
        <div className='rickscroll__partition' key={partitionIndex} style={partitionStyle}>
          {_.map(
            row,
            ({
              className,
              contentComponent,
              contentClassName,
              gutters,
              height,
              isHeader,
              key,
              props: rowProps
            }, innerIndex) => light
              ? (
                <LightweightRow
                  className={className}
                  contentClassName={contentClassName}
                  contentComponent={contentComponent}
                  horizontalTransform={horizontalTransform}
                  isFastScrolling={isScrolling && isFastScrolling}
                  isScrolling={isScrolling}
                  key={key || innerIndex}
                  passthroughOffsets={passthroughOffsets}
                  rowHeight={height}
                  rowProps={rowProps}
                  scrollsHorizontally={!!horizontalScrollConfig}
                  width={weightedWidth}
                />
              )
              : (
                <Row
                  className={className}
                  contentClassName={contentClassName}
                  contentComponent={contentComponent}
                  dynamicColumn={dynamicColumn}
                  gutters={gutters}
                  guttersConfig={guttersConfig}
                  horizontalTransform={horizontalTransform}
                  index={innerIndex}
                  isFastScrolling={isScrolling && isFastScrolling}
                  isScrolling={isScrolling}
                  key={key || innerIndex}
                  onStartResize={this._startResize}
                  passthroughOffsets={passthroughOffsets}
                  rowHeight={height}
                  rowProps={rowProps}
                  scrollsHorizontally={!!horizontalScrollConfig}
                  width={weightedWidth}
                />
              )
          )}
        </div>
      );
    });

    const { bottomHeaderGutter, header, topHeaderGutter } = this._renderHeader();

    // TODO remove partitions and shift the contents of the div
    return (
      <div className='rickscroll__contents' key='contents' style={contentsStyle}>
        {header}
        {topHeaderGutter}
        {renderedPartitions}
        {bottomHeaderGutter}
      </div>
    );
  }

  _renderCorner() {
    const {
      props: {
        horizontalScrollConfig,
        horizontalScrollConfig: {
          scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
        } = {},
        verticalScrollConfig: {
          scrollbarWidth = constants.VERTICAL_SCROLLBAR_WIDTH
        } = {}
      },
      state: { shouldRender }
    } = this;

    const shouldRenderCorner = !!horizontalScrollConfig && shouldRender.verticalScrollbar;

    if (!shouldRenderCorner) {
      return null;
    }

    const cornerStyle = {
      height: `${scrollbarHeight}px`,
      width: `${scrollbarWidth}px`
    };

    return <div className='rickscroll__corner' style={cornerStyle} />;
  }

  _renderHeader() {
    const {
      props: {
        dynamicColumn = constants.columns.MIDDLE,
        guttersConfig,
        headerType = constants.headerType.DEFAULT,
        height,
        horizontalScrollConfig: {
          scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
        } = {},
        light
      },
      state: {
        headers,
        isScrolling,
        isFastScrolling,
        rows,
        shouldRender,
        verticalTransform
      }
    } = this;

    if (!headers || headers.length === 0) {
      return {};
    }

    const { lockPosition: maxLockPosition } = headers[headers.length - 1];
    const findNextHeaderIndex = _.findIndex(headers, ({ lockPosition }) => lockPosition > verticalTransform);
    const nextHeaderIndex = findNextHeaderIndex === -1 ? headers.length : findNextHeaderIndex;
    const weightedWidth = this._getWeightedWidth();

    if (headerType === constants.headerType.STACKING) {
      const topHeaderGutter = (
        <div className='rickscroll__header-gutter rickscroll__header-gutter--top' key='top-header-gutter'>
          {_.times(nextHeaderIndex, headerIndex => {
            const { index: headerRowIndex } = headers[headerIndex];
            const { className, contentComponent, height: rowHeight, key, props: rowProps } = rows[headerRowIndex];

            return light
              ? (
                <LightweightRow
                  className={className}
                  contentComponent={contentComponent}
                  horizontalTransform={0}
                  isFastScrolling={isScrolling && isFastScrolling}
                  isHeader
                  isScrolling={isScrolling}
                  key={key || headerIndex}
                  rowHeight={rowHeight}
                  rowProps={rowProps}
                  scrollsHorizontally={false}
                  width={weightedWidth}
                />
              )
              : (
                <Row
                  className={className}
                  contentComponent={contentComponent}
                  dynamicColumn={dynamicColumn}
                  guttersConfig={guttersConfig}
                  horizontalTransform={0}
                  index={headerRowIndex}
                  isFastScrolling={isScrolling && isFastScrolling}
                  isHeader
                  isScrolling={isScrolling}
                  key={key || headerIndex}
                  rowHeight={rowHeight}
                  rowProps={rowProps}
                  scrollsHorizontally={false}
                  width={weightedWidth}
                />
              );
          })}
        </div>
      );

      let bottomGutterStartIndex = nextHeaderIndex;
      /* We want to erase headers as they come into view in the contents view from the header gutter
       * We solve for the vertical transform that we need to remove a header from the bottom gutter:
       * height: height of the header we are transitioning
       * topHeight: height of all other gutters pinned to the top, not including baseHeight
       * realOffset: the verticalTransform that aligns the next header with the top of the rickscroll__contents
       * bottomHeight: the height of the bottom gutter of combined headers
       * adjustedBottomHeight: the total height of the headers in the bottom gutter with the baseHeight
       * adjustedTransform: the vertical transform that is adjusted to the scale of viewable contents
       * ------------------------------------------------------------------------------------------------------------
       * we should delete the top header from the bottom gutter if the adjusted transform is smaller than the
       * height of contents window
       */
      const contentsDivHeight = height - (shouldRender.horizontalScrollbar ? scrollbarHeight : 0);
      const { height: baseHeight } = headers[0];
      const {
        adjustHeaderOffset: topHeight,
        realOffset: removeFirstHeaderOffset
      } = headers[nextHeaderIndex] || headers[nextHeaderIndex - 1];
      const { adjustHeaderOffset: bottomHeight } = headers[headers.length - 1];
      const adjustedBottomHeight = (baseHeight + bottomHeight) - topHeight;
      const adjustedTransform = (removeFirstHeaderOffset - verticalTransform) + adjustedBottomHeight;
      if (bottomGutterStartIndex !== headers.length && adjustedTransform <= contentsDivHeight - 1) {
        bottomGutterStartIndex++;
        const skipHeadersUntil = _(headers)
          .slice(bottomGutterStartIndex)
          .findIndex(({ adjustHeaderOffset, realOffset }) => {
            const restHeight = bottomHeight - adjustHeaderOffset;
            return realOffset + topHeight >= ((contentsDivHeight + verticalTransform) - restHeight);
          });

        if (skipHeadersUntil >= 0) {
          bottomGutterStartIndex += skipHeadersUntil;
        } else {
          bottomGutterStartIndex = headers.length;
        }
      }

      const bottomHeaderGutter = (
        <div className='rickscroll__header-gutter rickscroll__header-gutter--bottom' key='bottom-header-gutter'>
          {_(headers).slice(bottomGutterStartIndex).map(({ index: headerRowIndex, lockPosition }, index) => {
            const headerIndex = bottomGutterStartIndex + index;
            const { className, contentComponent, height: rowHeight, key, props: rowProps } = rows[headerRowIndex];

            return light
             ? (
               <LightweightRow
                 className={className}
                 contentComponent={contentComponent}
                 horizontalTransform={0}
                 isFastScrolling={isScrolling && isFastScrolling}
                 isHeader
                 isScrolling={isScrolling}
                 key={key || headerIndex}
                 rowHeight={rowHeight}
                 rowProps={rowProps}
                 scrollsHorizontally={false}
                 width={weightedWidth}
               />
             )
             : (
              <Row
                className={className}
                contentComponent={contentComponent}
                dynamicColumn={dynamicColumn}
                guttersConfig={guttersConfig}
                horizontalTransform={0}
                index={headerRowIndex}
                isFastScrolling={isScrolling && isFastScrolling}
                isHeader
                isScrolling={isScrolling}
                key={key || headerIndex}
                rowHeight={rowHeight}
                rowProps={rowProps}
                scrollsHorizontally={false}
                width={weightedWidth}
              />
            );
          }).value()}
        </div>
      );

      return { bottomHeaderGutter, topHeaderGutter };
    } else if (headerType === constants.headerType.LOCKING) {
      const headerIndex = nextHeaderIndex - 1;
      const { lockPosition } = headers[nextHeaderIndex] || headers[headerIndex];

      const { index: headerRowIndex } = headers[headerIndex];
      const { className, contentComponent, height: rowHeight, key, props: rowProps } = rows[headerRowIndex];

      const headerStyle = {
        height: `${rowHeight}px`,
        transform: 'translate3d(0px, 0px, 0px)'
      };

      if (verticalTransform < maxLockPosition && verticalTransform >= lockPosition - rowHeight) {
        const overlap = (lockPosition - verticalTransform);
        const headerOffset = rowHeight - overlap;
        headerStyle.transform = `translate3d(0px, -${headerOffset}px, 0px)`;
      }

      const rowContent = light
        ? (
          <LightweightRow
            className={className}
            contentComponent={contentComponent}
            horizontalTransform={0}
            isFastScrolling={isScrolling && isFastScrolling}
            isHeader
            isScrolling={isScrolling}
            key={key || headerRowIndex}
            rowHeight={rowHeight}
            rowProps={rowProps}
            scrollsHorizontally={false}
            width={weightedWidth}
          />
        )
        : (
          <Row
            className={className}
            contentComponent={contentComponent}
            dynamicColumn={dynamicColumn}
            guttersConfig={guttersConfig}
            horizontalTransform={0}
            index={headerRowIndex}
            isFastScrolling={isScrolling && isFastScrolling}
            isHeader
            isScrolling={isScrolling}
            key={key || headerRowIndex}
            rowHeight={rowHeight}
            rowProps={rowProps}
            scrollsHorizontally={false}
            width={weightedWidth}
          />
        );

      const header = (
        <div className='rickscroll__header' key={`header-${headerRowIndex}`} style={headerStyle}>
          {rowContent}
        </div>
      );

      return { header };
    }

    return {};
  }

  /**
   * Decides whether or not to render the horizontal scroll bar
   * @return null or a container with horizontal scrollbar and maybe the corner piece
   */
  _renderHorizontalScrollbar() {
    const {
      props: {
        dynamicColumn = constants.columns.MIDDLE,
        guttersConfig,
        guttersConfig: {
          left,
          left: {
            handleWidth: leftHandleWidth = constants.LEFT_HANDLE_WIDTH,
            position: leftHandlePosition
          } = {},
          right,
          right: {
            handleWidth: rightHandleWidth = constants.RIGHT_HANDLE_WIDTH,
            position: rightHandlePosition
          } = {}
        } = {},
        horizontalScrollConfig,
        horizontalScrollConfig: {
          className,
          scaleWithCenterContent = false,
          scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
        } = {},
        verticalScrollConfig: {
          scrollbarWidth = constants.VERTICAL_SCROLLBAR_WIDTH
        } = {}
      },
      state: { shouldRender }
    } = this;

    const withHorizontalScrolling = !!horizontalScrollConfig && shouldRender.horizontalScrollbar;

    if (!withHorizontalScrolling) {
      return null;
    }

    // TODO fix scaleWithCenterContent
    const contentWidth = this._getContentWidth();
    const { leftGutterWidth, rightGutterWidth } = getGutterWidths({
      dynamicColumn: guttersConfig
        ? dynamicColumn
        : constants.columns.MIDDLE,
      leftHandlePosition,
      leftHandleWidth,
      rightHandlePosition,
      rightHandleWidth,
      width: this._getWeightedWidth()
    });
    const shouldRenderCorner = !!horizontalScrollConfig && shouldRender.verticalScrollbar;
    const cornerWidth = returnWidthIfComponentExists(scrollbarWidth, shouldRenderCorner);
    let adjustedContentWidth = contentWidth - cornerWidth;
    let leftWidth;
    let position;
    let scaledWidth;

    // If the scale with center content flag is enabled, we will adjust the scrollbar to be in the correct position
    // and set up the width to be equivelant to the center content
    // we will also have to adjust the size of the filler content by the gutters
    if (scaleWithCenterContent) {
      const rightWidth = returnWidthIfComponentExists(rightHandleWidth + rightGutterWidth, right);

      leftWidth = returnWidthIfComponentExists(leftHandleWidth + leftGutterWidth, left);
      adjustedContentWidth -= leftWidth + rightWidth;
      position = 'relative';
      scaledWidth = `calc(100% - ${leftWidth}px - ${rightWidth}px - ${cornerWidth}px)`;
    }

    const wrapperStyle = {
      height: `${scrollbarHeight}px`
    };

    const scrollBarDivStyle = {
      height: `${scrollbarHeight}px`,
      left: leftWidth,
      position,
      width: scaledWidth
    };

    const fillerStyle = { height: '1px', width: `${adjustedContentWidth}px` };

    const getHorizontalScrollbarRef = r => { this._horizontalScrollbar = r; };
    const horizontalScrollbarClassName = classnames('rickscroll__horizontal-scrollbar', className);

    return (
      <div className='rickscroll__bottom-wrapper' style={wrapperStyle}>
        <div
          className={horizontalScrollbarClassName}
          key='scrollable'
          onScroll={this._onHorizontalScroll}
          ref={getHorizontalScrollbarRef}
          style={scrollBarDivStyle}
        >
          <div style={fillerStyle} /> {/* this causes the scrollbar to appear */}
        </div>
        {this._renderCorner()}
      </div>
    );
  }

  /**
   * Decides whether or not to render the vertical scroll bar
   * @return null or a container with vertical scrollbar
   */
  _renderVerticalScrollbar() {
    const {
      props: {
        verticalScrollConfig: {
          className,
          scrollbarWidth = constants.VERTICAL_SCROLLBAR_WIDTH
        } = {}
      },
      state: { contentHeight, shouldRender }
    } = this;

    if (!shouldRender.verticalScrollbar) {
      return null;
    }

    const fillerStyle = {
      height: `${contentHeight}px`,
      width: '1px'
    };
    const verticalScrollbarStyle = {
      minWidth: `${scrollbarWidth}px`
    };

    const getVerticalScrollbarRef = r => { this._verticalScrollbar = r; };
    const verticalScrollbarCassName = classnames('rickscroll__vertical-scrollbar', className);
    return (
      <div
        className={verticalScrollbarCassName}
        onScroll={this._onVerticalScroll}
        ref={getVerticalScrollbarRef}
        style={verticalScrollbarStyle}
      >
        <div style={fillerStyle} /> {/* this causes the scrollbar to appear */}
      </div>
    );
  }

  /**
   * Decides which scrollbars should be showing based off of the dimensions of the content and rickscroll container.
   * @return { horizontalScrollbar, verticalScrollbar } a pair of booleans that tell rickscroll whether or not to render
   *                                                    the horizontal and vertical scrollbars
   */
  _shouldRenderScrollbars(contentHeight, height, width) {
    const {
      props: {
        horizontalScrollConfig: {
          scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
        } = {},
        verticalScrollConfig: {
          scrollbarWidth = constants.VERTICAL_SCROLLBAR_WIDTH
        } = {}
      }
    } = this;

    const clientHeightTooSmall = height < contentHeight;
    const clientHeightTooSmallWithHorizontalScrollbar = height < (contentHeight + scrollbarHeight);

    const contentWidth = this._getContentWidth();
    const clientWidthTooSmall = width < contentWidth;
    const clientWidthTooSmallWithVerticalScrollbar = width < (contentWidth + scrollbarWidth);

    const shouldRenderVerticalScrollbar = clientHeightTooSmall || (
      clientWidthTooSmall && clientHeightTooSmallWithHorizontalScrollbar
    );
    const shouldRenderHorizontalScrollbar = clientWidthTooSmall || (
      clientHeightTooSmall && clientWidthTooSmallWithVerticalScrollbar
    );

    return {
      horizontalScrollbar: shouldRenderHorizontalScrollbar,
      verticalScrollbar: shouldRenderVerticalScrollbar
    };
  }

  _startHorizontalScroll(scrollTo) {
    const {
      animation: oldAnimation
    } = this.state;

    const animation = new AnimationTimer()
      .on('tick', this._getThrottledHorizontalAnimationFrameFn(scrollTo))
      .play();
    this.setState({ animation }, () => {
      if (oldAnimation) {
        oldAnimation.stop();
      }
      animation.play();
    });
  }

  _startResize(side) {
    return ({ clientX }) => {
      document.addEventListener('mouseup', this._stopResize, { capture: true });
      const {
        guttersConfig: {
          [side]: {
            position: basePosition
          }
        } = {}
      } = this.props;
      this.setState({
        resize: {
          basePosition,
          performing: true,
          side,
          startingPosition: clientX
        }
      });
    };
  }

  _stopResize() {
    document.removeEventListener('mouseup', this._stopResize, { capture: true });
    const { side } = this.state.resize;
    const {
      guttersConfig: {
        [side]: {
          onResizeEnd = (() => {}),
          position
        } = {}
      } = {}
    } = this.props;
    this.setState({
      resize: {
        basePosition: 0,
        performing: false,
        side: '',
        startingPosition: 0
      }
    });
    onResizeEnd(position);
  }

  _switchScrollProp(scrollTo) {
    const {
      horizontalTransform,
      verticalTransform
    } = this.state;

    if (
      (scrollTo.location.x === 0 && scrollTo.location.y === 0)
      || (scrollTo.preserveHorizontal && scrollTo.preserveVertical)
    ) {
      return;
    }

    const x = scrollTo.preserveHorizontal
      ? horizontalTransform
      : scrollTo.location.x;
    const y = scrollTo.preserveVertical
      ? verticalTransform
      : scrollTo.location.y;

    switch (scrollTo.type) {
      case constants.scrollType.ROW:
        this.scrollRowToMiddle(y, x);
        break;
      case constants.scrollType.HEADER:
        this.scrollToHeader(y, x);
        break;
      default:
        this.scrollTo({ x, y });
        break;
    }
  }

  // public

  scrollRowToMiddle(rowIndex, x = 0) {
    const {
      props: {
        height,
        horizontalScrollConfig: {
          scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
        }
      },
      state: {
        rowOffsets,
        shouldRender,
        verticalTransform
      }
    } = this;

    if (rowIndex < 0 || rowIndex >= rowOffsets.length) {
      return;
    }

    const {
      height: rowHeight,
      offset
    } = rowOffsets[rowIndex];

    let adjustedHeight = shouldRender.horizontalScrollbar
      ? height - scrollbarHeight
      : height;
    adjustedHeight -= this._getBottomGutterHeight();

    const adjustedVerticalTransform = verticalTransform + this._getTopGutterHeight();
    const needsYScroll = adjustedVerticalTransform > offset
      || verticalTransform + adjustedHeight < offset + rowHeight;
    const y = needsYScroll
      ? offset - (adjustedHeight / 2)
      : verticalTransform;

    this.scrollTo({ x, y });
  }

  scrollTo({ x = 0, y = 0 }) {
    const {
      props: {
        onRegisteredScrollTo = () => {}
      }, state: {
        animation,
        horizontalTransform,
        verticalTransform
      }
    } = this;

    if (horizontalTransform === x && verticalTransform === y) {
      return;
    }

    const scrollingToPosition = new Point(x, y);
    const stateTransition = {
      scrollingToPosition
    };

    if (horizontalTransform === x && verticalTransform !== y) {
      stateTransition.animation = new AnimationTimer()
        .on('tick', this._getThrottledVerticalAnimationFrameFn(scrollingToPosition));
    } else if (horizontalTransform !== x && verticalTransform === y) {
      this._debouncedStartHorizontalScroll(scrollingToPosition);
    } else {
      stateTransition.animation = new AnimationTimer()
        .on('tick', this._getThrottledVerticalAnimationFrameFn(scrollingToPosition))
        .on('stop', () => {
          if (!_.isEqual(this.state.scrollingToPosition, scrollingToPosition)) {
            return;
          }

          this._debouncedStartHorizontalScroll(scrollingToPosition);
        });
    }

    this.setState(stateTransition, () => {
      if (animation) {
        animation.stop();
      }
      if (stateTransition.animation) {
        stateTransition.animation.play();
      }
    });
    onRegisteredScrollTo();
  }

  scrollToHeader(headerIndex, x = 0) {
    const {
      props: { lists },
      state: { headers }
    } = this;

    if (!lists || headerIndex >= lists.length || headerIndex < 0) {
      return;
    }

    this.scrollTo({ x, y: headers[headerIndex].lockPosition });
  }

  toggleSection(sectionIndex) {
    const {
      props: {
        headerType = constants.headerType.DEFAULT,
        lists
      },
      state: { collapsedSections: oldCollapsedSections }
    } = this;
    const stackHeaders = headerType === constants.headerType.STACKING;

    if (!lists || sectionIndex >= lists.length || sectionIndex < 0) {
      return;
    }

    const collapsedState = !oldCollapsedSections[sectionIndex];
    oldCollapsedSections[sectionIndex] = collapsedState;

    const {
      avgRowHeight,
      collapsedSections,
      contentHeight,
      headers,
      partitions,
      rowOffsets,
      rows
    } = buildRowConfig(lists, stackHeaders, oldCollapsedSections);
    this.setState({ avgRowHeight, collapsedSections, contentHeight, headers, partitions, rowOffsets, rows });
  }

  render() {
    const {
      className,
      height,
      horizontalScrollConfig,
      horizontalScrollConfig: {
        scrollbarHeight = constants.HORIZONTAL_SCROLLBAR_HEIGHT
      } = {},
      style = {},
      width,
      wrappedWithAutoAdjust
    } = this.props;
    const {
      resize: { performing },
      shouldRender
    } = this.state;

    const scrollableClassName = classnames('rickscroll', {
      'rickscroll--performing-resize': performing
    }, className);
    const topWrapperStyle = !!horizontalScrollConfig && shouldRender.horizontalScrollbar ? {
      height: `calc(100% - ${scrollbarHeight}px)`
    } : undefined;

    const rickscrollStyle = wrappedWithAutoAdjust
      ? style
      : {
        ...style,
        height: `${height}px`,
        width: `${width}px`
      };

    return (
      <div className={scrollableClassName} style={rickscrollStyle}>
        <div
          className='rickscroll__top-wrapper'
          key='top-wrapper'
          onMouseMove={this._onResize}
          onMouseUp={this._stopResize}
          onWheel={this._onMouseWheel}
          style={topWrapperStyle}
        >
          {this._renderContents()}
          {this._renderVerticalScrollbar()}
        </div>
        {this._renderHorizontalScrollbar()}
      </div>
    );
  }
}

Scrollable.propTypes = {
  className: types.string,
  disableBidirectionalScrolling: types.bool,
  dynamicColumn: customTypes.column,
  guttersConfig: customTypes.guttersConfig,
  headerType: customTypes.headerType,
  height: types.number.isRequired,
  horizontalScrollConfig: customTypes.horizontalScrollConfig,
  light: types.bool,
  list: customTypes.list,
  lists: customTypes.lists,
  onRegisteredScrollTo: types.func,
  scrollTo: customTypes.scrollTo,
  style: types.object,
  verticalScrollConfig: customTypes.verticalScrollConfig,
  width: types.number.isRequired,
  wrappedWithAutoAdjust: types.bool
};
