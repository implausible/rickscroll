import React, { PropTypes as types } from 'react';
import _ from 'lodash';

export default class HorizontalWrapper extends React.Component {
  shouldComponentUpdate(nextProps, nextState) {
    return !_.isEqual(nextProps, this.props) || !_.isEqual(nextState, this.state);
  }

  render() {
    const { children, offset } = this.props;
    const horizontalWrapperStyle = {
      transform: `translate3d(-${offset}px, -0px, 0px)`
    };
    return <div className='rickscroll__horizontal-wrapper' style={horizontalWrapperStyle}>{children}</div>;
  }
}

HorizontalWrapper.propTypes = {
  children: types.node.isRequired,
  offset: types.number.isRequired
};
